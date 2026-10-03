const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const DB_FILE = path.join(__dirname, '..', 'data', 'videos.json');
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'videos');
const THUMB_DIR = path.join(__dirname, '..', 'public', 'uploads', 'thumbnails');

// Ensure upload directories exist (guarded for read-only serverless filesystems like Vercel /var/task)
try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
} catch (e) {
  // Read-only filesystem on serverless runtime
}

try {
  if (!fs.existsSync(THUMB_DIR)) {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
  }
} catch (e) {
  // Read-only filesystem on serverless runtime
}

// In-memory cache + disk persistence for zero-downtime fallback
let fallbackVideos = [];
try {
  if (fs.existsSync(DB_FILE)) {
    fallbackVideos = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Ensure all items have placements array
    fallbackVideos.forEach(v => {
      if (!Array.isArray(v.placements)) {
        v.placements = v.isAssignedTo && v.isAssignedTo !== 'none' ? [v.isAssignedTo] : [];
      }
    });
  }
} catch (err) {
  console.error('Failed to load videos.json:', err);
  fallbackVideos = [];
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(fallbackVideos, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save videos.json:', err);
  }
}

// -------------------------------------------------------------
// MongoDB Schema & Model
// -------------------------------------------------------------
const VideoSchema = new mongoose.Schema({
  _id: {
    type: mongoose.Schema.Types.Mixed,
    default: () => new mongoose.Types.ObjectId().toString()
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  artist: {
    type: String,
    default: '',
    trim: true
  },
  mediaType: {
    type: String,
    enum: ['video', 'music'],
    default: 'video'
  },
  audioFormat: {
    type: String,
    default: null
  },
  type: {
    type: String,
    enum: ['s3', 'youtube'],
    default: 's3'
  },
  sourceUrl: {
    type: String,
    required: true,
    trim: true
  },
  fileKey: {
    type: String,
    default: null
  },
  youtubeId: {
    type: String,
    default: null
  },
  thumbnail: {
    type: String,
    default: null
  },
  // Multiple selection placements: e.g. ['home_trailer', 'home_gameplay', 'media_page', 'music']
  placements: {
    type: [String],
    default: [],
    index: true
  },
  // Backward compatibility flag
  isAssignedTo: {
    type: String,
    default: 'none',
    index: true
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  collection: 'videos',
  toJSON: {
    transform: (doc, ret) => {
      ret._id = String(ret._id);
      if (!Array.isArray(ret.placements)) {
        ret.placements = ret.isAssignedTo && ret.isAssignedTo !== 'none' ? [ret.isAssignedTo] : [];
      }
      return ret;
    }
  }
});

const Video = mongoose.models.Video || mongoose.model('Video', VideoSchema);

// Universal secret/env resolver: checks process.env, Render Secret Files (/etc/secrets/<KEY>), and mounted .env
function getSecret(key) {
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return String(process.env[key]).trim();
  }
  // Check Render Secret Files (/etc/secrets/<key>)
  try {
    const directPath = path.join('/etc/secrets', key);
    if (fs.existsSync(directPath)) {
      return fs.readFileSync(directPath, 'utf8').trim();
    }
  } catch (e) {}
  try {
    const lowerPath = path.join('/etc/secrets', key.toLowerCase());
    if (fs.existsSync(lowerPath)) {
      return fs.readFileSync(lowerPath, 'utf8').trim();
    }
  } catch (e) {}
  try {
    const envPath = '/etc/secrets/.env';
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (match) return match[1].trim();
    }
  } catch (e) {}
  return '';
}

let isMongoConnected = false;
let mongoPromise = null;

// Ensure MongoDB connection in both persistent servers and serverless functions (Vercel)
async function ensureMongo() {
  if (isMongoConnected && mongoose.connection.readyState === 1) return true;
  const mongoUri = getSecret('MONGO_URI');
  if (!mongoUri) return false;

  if (!mongoPromise) {
    mongoPromise = mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      bufferCommands: false
    }).then(async () => {
      isMongoConnected = true;
      console.log('[MediaManager] Connected to MongoDB Atlas cluster (igvDB.videos)');
      return true;
    }).catch(err => {
      mongoPromise = null;
      isMongoConnected = false;
      console.warn('[MediaManager] MongoDB connection warning:', err.message);
      return false;
    });
  }
  return mongoPromise;
}

// Connect to MongoDB if MONGO_URI is set
async function initMongo() {
  return ensureMongo();
}

mongoose.connection.on('connected', async () => {
  isMongoConnected = true;
  try {
    const count = await Video.countDocuments();
    if (count === 0 && fallbackVideos.length > 0) {
      console.log('[MediaManager] Seeding MongoDB with existing fallback videos...');
      for (const item of fallbackVideos) {
        await Video.create({
          title: item.title,
          type: item.type,
          sourceUrl: item.sourceUrl,
          fileKey: item.fileKey,
          youtubeId: item.youtubeId,
          thumbnail: item.thumbnail,
          isAssignedTo: item.isAssignedTo,
          placements: item.placements || (item.isAssignedTo ? [item.isAssignedTo] : []),
          mediaType: item.mediaType || 'video',
          artist: item.artist || '',
          audioFormat: item.audioFormat || 'none',
          uploadedAt: item.uploadedAt || new Date()
        });
      }
      console.log('[MediaManager] MongoDB seeded successfully.');
    }
  } catch (err) {
    console.warn('[MediaManager] Seeding warning:', err.message);
  }
});
mongoose.connection.on('disconnected', () => {
  isMongoConnected = false;
  mongoPromise = null;
  console.warn('[MediaManager] MongoDB disconnected, using JSON fallback.');
});
mongoose.connection.on('error', (err) => {
  console.warn('[MediaManager] MongoDB error:', err.message);
});

// Kick off async connection immediately
initMongo();

function getDbStatus() {
  return {
    type: isMongoConnected ? 'mongodb' : 'json',
    connected: isMongoConnected,
    database: isMongoConnected ? 'igvDB' : 'local_json',
    collection: 'videos',
    hasMongoUri: !!getSecret('MONGO_URI')
  };
}

// -------------------------------------------------------------
// S3 Configuration & Client
// -------------------------------------------------------------
function getS3Config() {
  const accessKeyId = getSecret('AWS_ACCESS_KEY_ID');
  const secretAccessKey = getSecret('AWS_SECRET_ACCESS_KEY');
  const region = getSecret('AWS_REGION') || 'us-east-1';
  const bucket = getSecret('AWS_S3_BUCKET') || '';

  const isConfigured = !!(accessKeyId && secretAccessKey && region && bucket);
  return {
    isConfigured,
    region,
    bucket,
    hasKey: !!accessKeyId,
    hasSecret: !!secretAccessKey,
    accessKeyId,
    secretAccessKey
  };
}

function getS3Client() {
  const s3Config = getS3Config();
  if (!s3Config.isConfigured) return null;
  return new S3Client({
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey
    }
  });
}

// Generate presigned PUT URL for direct browser-to-S3 upload
// Completely bypasses Vercel/server 4.5MB payload limits (supports 500MB+ files)
async function getS3UploadPresignedUrl(fileName, contentType = 'video/mp4', expiresIn = 3600) {
  const s3Config = getS3Config();
  const s3 = getS3Client();
  if (!s3 || !s3Config.isConfigured) {
    throw new Error('AWS S3 is not configured. Please add AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and AWS_S3_BUCKET.');
  }

  const ext = path.extname(fileName) || '.mp4';
  const cleanBase = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const isAudio = (contentType && contentType.startsWith('audio/')) || ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext.toLowerCase());
  const folder = isAudio ? 'igv_music' : 'igv_videos';
  const fileKey = `${folder}/${Date.now()}_${cleanBase}${ext}`;

  const command = new PutObjectCommand({
    Bucket: s3Config.bucket,
    Key: fileKey,
    ContentType: contentType
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn });
  const cloudFrontDomain = getSecret('CLOUDFRONT_DOMAIN') || '';
  const cleanDomain = cloudFrontDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');

  const playbackUrl = cleanDomain
    ? `https://${cleanDomain}/${fileKey}`
    : `/api/videos/stream?key=${encodeURIComponent(fileKey)}`;

  return {
    uploadUrl,
    fileKey,
    playbackUrl,
    cloudFrontDomain: cleanDomain || null,
    bucket: s3Config.bucket,
    region: s3Config.region
  };
}

// Generate presigned URL for private S3 buckets
async function getS3SignedPlaybackUrl(fileKey, expiresIn = 7200) {
  const s3Config = getS3Config();
  const s3 = getS3Client();
  if (!s3 || !fileKey) return null;
  try {
    return await getSignedUrl(s3, new GetObjectCommand({
      Bucket: s3Config.bucket,
      Key: fileKey
    }), { expiresIn });
  } catch (err) {
    console.error('[MediaManager] Presign URL error:', err.message);
    return null;
  }
}

// -------------------------------------------------------------
// HTTP 206 Byte-Range Chunked Retrieval
// Fast start: streams 2MB chunks on-demand instead of downloading full 40MB
// -------------------------------------------------------------
async function streamVideoChunk(fileKey, req, res) {
  const s3Config = getS3Config();
  const s3 = getS3Client();

  if (s3 && fileKey && (fileKey.startsWith('igv_videos/') || fileKey.startsWith('igv_music/'))) {
    try {
      // 1. Verify existence in S3 bucket
      await s3.send(new HeadObjectCommand({
        Bucket: s3Config.bucket,
        Key: fileKey
      }));

      // 2. High-speed Direct S3 Playback:
      // Redirect directly to S3 Mumbai (ap-south-1) with a presigned GET URL.
      const signed = await getS3SignedPlaybackUrl(fileKey, 7200);
      if (signed) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.redirect(302, signed);
      }
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return res.status(404).send('Media file not found in current S3 storage bucket.');
      }
      console.error('[MediaManager] S3 Stream Error:', err.message);
    }
  }

  // Local storage chunk streaming fallback
  const localFileName = path.basename(fileKey || '');
  const localFilePath = path.join(UPLOAD_DIR, localFileName);
  if (fs.existsSync(localFilePath)) {
    const stat = fs.statSync(localFilePath);
    const totalSize = stat.size;
    const range = req.headers.range;
    const CHUNK_SIZE = 1024 * 1024 * 2; // 2MB

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : start + CHUNK_SIZE - 1;
      if (end >= totalSize) end = totalSize - 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=86400'
      });
      return fs.createReadStream(localFilePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': totalSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4'
      });
      return fs.createReadStream(localFilePath).pipe(res);
    }
  }

  res.status(404).send('Video stream not found');
}

// -------------------------------------------------------------
// Image & Thumbnail Upload to S3 or Local
// -------------------------------------------------------------
async function uploadImageFile(fileBuffer, originalName, mimeType) {
  const s3Config = getS3Config();
  const s3 = getS3Client();
  const ext = path.extname(originalName) || '.jpg';
  const cleanBase = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileKey = `igv_videos/thumbnails/${Date.now()}_${cleanBase}${ext}`;

  if (s3) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: fileKey,
        Body: fileBuffer,
        ContentType: mimeType || 'image/jpeg'
      }));

      // Return stream URL or direct S3 URL
      return `/api/videos/stream?key=${encodeURIComponent(fileKey)}`;
    } catch (err) {
      console.error('[MediaManager] S3 Image Upload Error:', err.message);
    }
  }

  // Local storage fallback
  try {
    const localFileName = `thumb_${Date.now()}_${cleanBase}${ext}`;
    const localFilePath = path.join(THUMB_DIR, localFileName);
    fs.writeFileSync(localFilePath, fileBuffer);
    return `/uploads/thumbnails/${localFileName}`;
  } catch (err) {
    console.error('[MediaManager] Local thumb write failed:', err.message);
    return '/images/posters/poster_full.0az_iud2g3y4j.jpg';
  }
}

// Optimize video with FFmpeg: apply stream copy + FastStart or H.264/AAC transcode
async function optimizeMediaWithFfmpeg(inputBuffer, originalName) {
  const ext = (path.extname(originalName) || '').toLowerCase();
  const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
  if (!videoExts.includes(ext)) {
    return { buffer: inputBuffer, finalExt: ext, contentType: null };
  }

  const tmpDir = os.tmpdir();
  const inPath = path.join(tmpDir, `in_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`);
  const outPath = path.join(tmpDir, `out_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.mp4`);

  try {
    fs.writeFileSync(inPath, inputBuffer);
    // 1. Try fast stream copy with FastStart (runs in <1s if H.264/AAC)
    try {
      await execFilePromise('ffmpeg', ['-y', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath]);
    } catch (copyErr) {
      console.log(`[MediaManager] Stream copy not possible for ${originalName}, transcoding with H.264/AAC + FastStart...`);
      await execFilePromise('ffmpeg', ['-y', '-i', inPath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath]);
    }

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      const optimizedBuffer = fs.readFileSync(outPath);
      return { buffer: optimizedBuffer, finalExt: '.mp4', contentType: 'video/mp4' };
    }
  } catch (err) {
    console.warn('[MediaManager] FFmpeg optimization warning:', err.message);
  } finally {
    try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch (e) {}
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
  }
  return { buffer: inputBuffer, finalExt: ext, contentType: null };
}

// Upload buffer to AWS S3 (under igv_videos/ or igv_music/) or fallback to local disk
async function uploadMediaFile(fileBuffer, originalName, mimeType) {
  const s3Config = getS3Config();
  const s3 = getS3Client();
  let ext = (path.extname(originalName) || '').toLowerCase() || '.mp4';
  let bufferToUpload = fileBuffer;
  let finalMime = mimeType || 'video/mp4';

  const isAudio = (mimeType && mimeType.startsWith('audio/')) || ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext);
  const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];

  // Automatically optimize videos with FastStart
  if (videoExts.includes(ext)) {
    try {
      const opt = await optimizeMediaWithFfmpeg(fileBuffer, originalName);
      bufferToUpload = opt.buffer;
      ext = opt.finalExt;
      if (opt.contentType) finalMime = opt.contentType;
    } catch (e) {
      console.warn('[MediaManager] FastStart remux skipped:', e.message);
    }
  }

  const cleanBase = path.basename(originalName, path.extname(originalName)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const folder = isAudio ? 'igv_music' : 'igv_videos';
  const fileKey = `${folder}/${Date.now()}_${cleanBase}${ext}`;

  if (s3) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: fileKey,
        Body: bufferToUpload,
        ContentType: finalMime
      }));

      const streamUrl = `/api/videos/stream?key=${encodeURIComponent(fileKey)}`;
      const directS3Url = `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${fileKey}`;
      return {
        sourceUrl: streamUrl,
        directS3Url,
        type: 's3',
        s3Used: true,
        fileKey
      };
    } catch (err) {
      console.error('[MediaManager] S3 Upload Error, falling back to local storage:', err.message);
    }
  }

  // Local storage fallback
  try {
    const localFileName = `${Date.now()}_${cleanBase}${ext}`;
    const localFilePath = path.join(UPLOAD_DIR, localFileName);
    fs.writeFileSync(localFilePath, bufferToUpload);

    const streamUrl = `/api/videos/stream?key=${encodeURIComponent(localFileName)}`;
    return {
      sourceUrl: streamUrl,
      type: 's3',
      s3Used: false,
      fileKey: localFileName
    };
  } catch (err) {
    console.error('[MediaManager] Local video write failed:', err.message);
    throw new Error('Storage unavailable: please configure AWS S3 environment variables.');
  }
}

// Remux/optimize an existing video in S3 into FastStart Progressive MP4
async function optimizeVideoOnS3(videoId) {
  await ensureMongo();
  const v = await getVideoById(videoId);
  if (!v) throw new Error('Media not found with id ' + videoId);
  if (v.type !== 's3' || !v.fileKey) throw new Error('Only S3 hosted media can be optimized with FastStart');

  const s3Config = getS3Config();
  const s3 = getS3Client();
  if (!s3 || !s3Config.bucket) throw new Error('S3 client not configured');

  const tmpDir = os.tmpdir();
  const inExt = path.extname(v.fileKey) || '.mp4';
  const inPath = path.join(tmpDir, `s3_in_${Date.now()}${inExt}`);
  const outPath = path.join(tmpDir, `s3_out_${Date.now()}.mp4`);

  try {
    console.log(`[MediaManager] Downloading S3 object ${v.fileKey} for FastStart remuxing...`);
    const s3Obj = await s3.send(new GetObjectCommand({
      Bucket: s3Config.bucket,
      Key: v.fileKey
    }));
    const chunks = [];
    for await (const chunk of s3Obj.Body) {
      chunks.push(chunk);
    }
    fs.writeFileSync(inPath, Buffer.concat(chunks));

    console.log(`[MediaManager] Running FFmpeg FastStart remux on ${inPath}...`);
    try {
      await execFilePromise('ffmpeg', ['-y', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath]);
    } catch (copyErr) {
      console.log(`[MediaManager] Fast stream copy not possible, transcoding:`, copyErr.message);
      await execFilePromise('ffmpeg', ['-y', '-i', inPath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath]);
    }

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      throw new Error('FFmpeg failed to produce optimized output file');
    }

    const newKey = v.fileKey.replace(/\.[a-zA-Z0-9]+$/, '') + '_faststart.mp4';
    const optBuffer = fs.readFileSync(outPath);
    await s3.send(new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: newKey,
      Body: optBuffer,
      ContentType: 'video/mp4'
    }));

    if (newKey !== v.fileKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: v.fileKey }));
      } catch (e) {}
    }

    const newSourceUrl = `/api/videos/stream?key=${encodeURIComponent(newKey)}`;
    if (isMongoConnected) {
      await Video.findByIdAndUpdate(v._id, {
        $set: { fileKey: newKey, sourceUrl: newSourceUrl }
      });
    }
    const local = fallbackVideos.find(x => String(x._id) === String(v._id));
    if (local) {
      local.fileKey = newKey;
      local.sourceUrl = newSourceUrl;
      saveDb();
    }

    return {
      success: true,
      fileKey: newKey,
      sizeBytes: optBuffer.length,
      message: 'FastStart optimization applied! Video will now stream in 1-2 requests.'
    };
  } finally {
    try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch (e) {}
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
  }
}

// Parse YouTube URL to extract ID, embedUrl, and thumbnail
function parseYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return null;

  let id = null;
  const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([^"&?\/\s]{11})/;
  const match = url.match(regExp);

  if (match && match[1]) {
    id = match[1];
  } else if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) {
    id = url.trim();
  }

  if (!id) return null;

  return {
    youtubeId: id,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  };
}

// -------------------------------------------------------------
// Video CRUD Operations
// -------------------------------------------------------------
function normalizeDoc(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  o._id = String(o._id);
  if (!Array.isArray(o.placements)) {
    o.placements = o.isAssignedTo && o.isAssignedTo !== 'none' ? [o.isAssignedTo] : [];
  }
  // Enforce source truth by file extension:
  // .mp4, .webm, .mkv, .avi, .mov or youtube = 100% VIDEO (audioFormat: 'none')
  // .mp3, .wav, .ogg, .flac, .aac = AUDIO TRACK (audioFormat: 'MP3', etc.)
  const key = (o.fileKey || o.sourceUrl || '').toLowerCase();
  const isVideoExt = o.type === 'youtube' || /\.(mp4|webm|mkv|avi|mov)(\?|$)/i.test(key);
  const isAudioExt = /\.(mp3|wav|ogg|flac|aac)(\?|$)/i.test(key);

  if (isVideoExt) {
    o.mediaType = 'video';
    o.audioFormat = 'none';
  } else if (isAudioExt) {
    o.mediaType = 'music';
    if (!o.audioFormat || o.audioFormat === 'none' || o.audioFormat.toLowerCase() === 'mp4') {
      const extMatch = key.match(/\.([a-z0-9]+)(\?|$)/i);
      o.audioFormat = extMatch ? extMatch[1].toUpperCase() : 'MP3';
    }
  }
  return o;
}

async function getAllVideos() {
  await ensureMongo();
  if (isMongoConnected) {
    try {
      const list = await Video.find().sort({ uploadedAt: -1 }).lean();
      return list.map(normalizeDoc);
    } catch (err) {
      console.warn('[MediaManager] Mongo getAllVideos failed, using fallback:', err.message);
    }
  }
  return [...fallbackVideos];
}

async function getVideoById(id) {
  await ensureMongo();
  if (isMongoConnected) {
    try {
      const v = await Video.findById(id).lean();
      if (v) return normalizeDoc(v);
    } catch (err) {
      console.warn('[MediaManager] Mongo getVideoById error:', err.message);
    }
  }
  return fallbackVideos.find(v => String(v._id) === String(id) || String(v.id) === String(id)) || null;
}

async function addVideo({ title, artist, mediaType, audioFormat, type, sourceUrl, fileKey, youtubeId, thumbnail, placements }) {
  await ensureMongo();
  // Prevent duplicate entries if both direct browser upload and S3-triggered Lambda submit the same fileKey
  if (fileKey) {
    if (isMongoConnected) {
      try {
        const existing = await Video.findOne({ fileKey }).lean();
        if (existing) return normalizeDoc(existing);
      } catch (e) {}
    }
    const local = fallbackVideos.find(v => v.fileKey === fileKey);
    if (local) return local;
  }

  const newId = 'v' + (Date.now().toString(36) + Math.random().toString(36).substr(2, 5));
  const validPlacements = ['home_trailer', 'home_gameplay', 'media_page', 'music', 'home_music', 'media_music'];
  let pArray = [];
  if (Array.isArray(placements)) {
    pArray = placements.filter(p => validPlacements.includes(p));
  } else if (typeof placements === 'string' && validPlacements.includes(placements)) {
    pArray = [placements];
  }

  const fileKeyOrUrl = (fileKey || sourceUrl || '').toLowerCase();
  const isExplicitVideo = type === 'youtube' || /\.(mp4|webm|mkv|avi|mov)(\?|$)/i.test(fileKeyOrUrl);
  const isExplicitAudio = /\.(mp3|wav|ogg|flac|aac)(\?|$)/i.test(fileKeyOrUrl);

  const finalMediaType = isExplicitVideo ? 'video' : (isExplicitAudio ? 'music' : (mediaType === 'music' ? 'music' : 'video'));
  const detectedFormat = isExplicitVideo
    ? 'none'
    : (isExplicitAudio
      ? (fileKey ? path.extname(fileKey).replace('.', '').toUpperCase() : 'MP3')
      : (finalMediaType === 'music' ? (audioFormat && audioFormat !== 'none' && audioFormat.toLowerCase() !== 'mp4' ? audioFormat.toUpperCase() : 'MP3') : 'none'));

  const defaultPoster = finalMediaType === 'music'
    ? '/images/posters/music_default.webp'
    : (type === 's3' ? '/images/posters/poster_full.0az_iud2g3y4j.jpg' : null);

  const primaryPlacement = pArray[0] || 'none';

  const record = {
    _id: newId,
    title: title || (finalMediaType === 'music' ? 'Untitled Soundtrack' : 'Untitled Broadcast'),
    artist: artist || '',
    mediaType: finalMediaType,
    audioFormat: detectedFormat,
    type: type === 's3' ? 's3' : 'youtube',
    sourceUrl: sourceUrl || '',
    fileKey: fileKey || null,
    youtubeId: youtubeId || null,
    thumbnail: thumbnail || defaultPoster,
    placements: pArray,
    isAssignedTo: primaryPlacement,
    uploadedAt: new Date()
  };

  // Save to fallback memory/file
  fallbackVideos.unshift({ ...record, uploadedAt: record.uploadedAt.toISOString() });
  saveDb();

  // Save to MongoDB if connected
  if (isMongoConnected) {
    try {
      const created = await Video.create(record);
      return normalizeDoc(created);
    } catch (err) {
      console.warn('[MediaManager] Mongo addVideo error:', err.message);
    }
  }

  return record;
}

// -------------------------------------------------------------
// Update Video Thumbnail (Image file or URL)
// -------------------------------------------------------------
async function updateVideoThumbnail(videoId, { thumbnailUrl, fileBuffer, originalName, mimeType }) {
  await ensureMongo();
  let finalThumbUrl = thumbnailUrl;

  if (fileBuffer) {
    finalThumbUrl = await uploadImageFile(fileBuffer, originalName || 'thumbnail.jpg', mimeType || 'image/jpeg');
  }

  if (!finalThumbUrl) {
    throw new Error('No thumbnail image provided');
  }

  let updatedVideo = null;
  if (isMongoConnected) {
    try {
      const res = await Video.findByIdAndUpdate(
        videoId,
        { $set: { thumbnail: finalThumbUrl } },
        { returnDocument: 'after' }
      ).lean();
      if (res) updatedVideo = normalizeDoc(res);
    } catch (err) {
      console.warn('[MediaManager] Mongo updateVideoThumbnail error:', err.message);
    }
  }

  const local = fallbackVideos.find(v => String(v._id) === String(videoId) || String(v.id) === String(videoId));
  if (local) {
    local.thumbnail = finalThumbUrl;
    saveDb();
    if (!updatedVideo) updatedVideo = { ...local };
  }

  if (!updatedVideo) {
    throw new Error(`Video not found with id ${videoId}`);
  }

  return updatedVideo;
}

// -------------------------------------------------------------
// Multiple Selection Placement Assignment Logic
// Handles: ['home_trailer', 'home_gameplay', 'media_page']
// -------------------------------------------------------------
async function assignVideoPlacement(videoId, targetPlacement, options = {}) {
  const validPlacements = ['home_trailer', 'home_gameplay', 'media_page', 'music', 'home_music', 'media_music'];

  let newPlacements = [];
  const existingVideo = await getVideoById(videoId);
  if (!existingVideo) throw new Error(`Media not found with id ${videoId}`);

  const currentPlacements = Array.isArray(existingVideo.placements) ? [...existingVideo.placements] : [];

  if (Array.isArray(targetPlacement)) {
    newPlacements = targetPlacement.filter(p => validPlacements.includes(p));
  } else if (typeof targetPlacement === 'object' && targetPlacement.placements) {
    newPlacements = targetPlacement.placements.filter(p => validPlacements.includes(p));
  } else if (typeof targetPlacement === 'string') {
    if (targetPlacement === 'none' || targetPlacement === 'unassign') {
      newPlacements = [];
    } else if (options.toggle !== undefined) {
      if (options.toggle) {
        newPlacements = Array.from(new Set([...currentPlacements, targetPlacement]));
      } else {
        newPlacements = currentPlacements.filter(p => p !== targetPlacement);
      }
    } else if (validPlacements.includes(targetPlacement)) {
      newPlacements = Array.from(new Set([...currentPlacements, targetPlacement]));
    }
  }

  const primaryPlacement = newPlacements[0] || 'none';
  let updatedVideo = null;

  if (isMongoConnected) {
    try {
      const res = await Video.findByIdAndUpdate(
        videoId,
        {
          $set: {
            placements: newPlacements,
            isAssignedTo: primaryPlacement
          }
        },
        { returnDocument: 'after' }
      ).lean();

      if (res) {
        updatedVideo = normalizeDoc(res);
      }
    } catch (err) {
      console.warn('[MediaManager] Mongo assignVideoPlacement error:', err.message);
    }
  }

  const local = fallbackVideos.find(v => String(v._id) === String(videoId) || String(v.id) === String(videoId));
  if (local) {
    local.placements = newPlacements;
    local.isAssignedTo = primaryPlacement;
    saveDb();
    if (!updatedVideo) updatedVideo = { ...local };
  }

  return updatedVideo;
}

async function deleteVideo(videoId, options = {}) {
  const purgeS3 = options.purgeS3 === true;
  await ensureMongo();
  let deleted = null;

  if (isMongoConnected) {
    try {
      const res = await Video.findByIdAndDelete(videoId).lean();
      if (res) deleted = normalizeDoc(res);
    } catch (err) {
      console.warn('[MediaManager] Mongo deleteVideo error:', err.message);
    }
  }

  const idx = fallbackVideos.findIndex(v => String(v._id) === String(videoId) || String(v.id) === String(videoId));
  if (idx !== -1) {
    const localDeleted = fallbackVideos.splice(idx, 1)[0];
    saveDb();
    if (!deleted) deleted = localDeleted;
  }

  // Delete from AWS S3 storage ONLY if purgeS3 is explicitly true
  if (deleted && purgeS3) {
    const s3Config = getS3Config();
    const s3 = getS3Client();
    if (s3 && s3Config.bucket) {
      // 1. Delete main video or audio file from S3
      if (deleted.fileKey && (deleted.fileKey.startsWith('igv_videos/') || deleted.fileKey.startsWith('igv_music/'))) {
        try {
          await s3.send(new DeleteObjectCommand({
            Bucket: s3Config.bucket,
            Key: deleted.fileKey
          }));
          console.log(`[MediaManager] S3 media file purged: ${deleted.fileKey}`);
        } catch (s3Err) {
          console.warn('[MediaManager] S3 media deletion warning:', s3Err.message);
        }
      }
      // 2. Delete custom S3 thumbnail if not default
      const thumbUrl = deleted.thumbnail || '';
      if (thumbUrl.includes('igv_videos/thumbnails/') && !thumbUrl.includes('poster_full') && !thumbUrl.includes('music_default')) {
        const thumbKeyMatch = thumbUrl.match(/(igv_videos\/thumbnails\/[^?&#]+)/);
        if (thumbKeyMatch && thumbKeyMatch[1]) {
          try {
            await s3.send(new DeleteObjectCommand({
              Bucket: s3Config.bucket,
              Key: decodeURIComponent(thumbKeyMatch[1])
            }));
            console.log(`[MediaManager] S3 custom thumbnail purged: ${thumbKeyMatch[1]}`);
          } catch (tErr) {
            console.warn('[MediaManager] S3 thumbnail deletion warning:', tErr.message);
          }
        }
      }
    }
  }

  return { ...deleted, purgedS3: purgeS3 };
}

// -------------------------------------------------------------
// S3 Direct Explorer & Peek Storage
// -------------------------------------------------------------
async function listS3Objects() {
  const s3Config = getS3Config();
  const s3 = getS3Client();
  if (!s3 || !s3Config.bucket) {
    return { isConfigured: false, error: 'AWS S3 is not configured', files: [] };
  }

  try {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: s3Config.bucket,
      MaxKeys: 300
    }));

    const allDbVideos = await getAllVideos();
    const dbKeyMap = new Map();
    allDbVideos.forEach(v => {
      if (v.fileKey) dbKeyMap.set(v.fileKey, v);
    });

    const items = (res.Contents || [])
      .filter(item => item.Key && !item.Key.endsWith('/'))
      .map(item => {
        const key = item.Key;
        const isThumbnail = key.includes('/thumbnails/');
        const isMusic = key.startsWith('igv_music/') || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(key);
        const fileName = path.basename(key);
        const existingVideo = dbKeyMap.get(key) || null;

        return {
          key,
          fileName,
          sizeBytes: item.Size,
          sizeMB: (item.Size / (1024 * 1024)).toFixed(2),
          lastModified: item.LastModified,
          streamUrl: `/api/videos/stream?key=${encodeURIComponent(key)}`,
          isThumbnail,
          isMusic,
          folder: key.startsWith('igv_music/') ? 'igv_music' : (key.startsWith('igv_videos/thumbnails') ? 'thumbnails' : 'igv_videos'),
          inDatabase: !!existingVideo,
          linkedVideoId: existingVideo ? existingVideo._id : null,
          linkedVideoTitle: existingVideo ? existingVideo.title : null
        };
      });

    return {
      success: true,
      isConfigured: true,
      bucket: s3Config.bucket,
      region: s3Config.region,
      totalCount: items.length,
      files: items
    };
  } catch (err) {
    console.error('[MediaManager] listS3Objects error:', err.message);
    throw err;
  }
}

async function deleteS3ObjectDirect(fileKey) {
  const s3Config = getS3Config();
  const s3 = getS3Client();
  if (!s3 || !s3Config.bucket) {
    throw new Error('AWS S3 is not configured');
  }
  if (!fileKey || (!fileKey.startsWith('igv_videos/') && !fileKey.startsWith('igv_music/'))) {
    throw new Error('Invalid or restricted S3 key');
  }

  await s3.send(new DeleteObjectCommand({
    Bucket: s3Config.bucket,
    Key: fileKey
  }));

  console.log(`[MediaManager] Directly deleted S3 object: ${fileKey}`);
  return { success: true, key: fileKey };
}

// -------------------------------------------------------------
// Elastic Active Placement Queries for Frontend
// -------------------------------------------------------------
async function getActivePlacement(placement) {
  const all = await getAllVideos();

  // Helper filter for multiple placements support
  const hasPlacement = (v, p) => {
    if (Array.isArray(v.placements) && v.placements.includes(p)) return true;
    return v.isAssignedTo === p;
  };

  if (placement === 'home_trailer') {
    return all.find(v => hasPlacement(v, 'home_trailer')) || null;
  }
  if (placement === 'home_gameplay') {
    return all.filter(v => hasPlacement(v, 'home_gameplay'));
  }
  if (placement === 'media_page') {
    return all.filter(v => hasPlacement(v, 'media_page'));
  }
  if (placement === 'music') {
    return all.filter(v => v.mediaType === 'music' || hasPlacement(v, 'music') || hasPlacement(v, 'home_music') || hasPlacement(v, 'media_music'));
  }
  if (placement === 'all') {
    return {
      home_trailer: all.find(v => hasPlacement(v, 'home_trailer')) || null,
      home_trailers: all.filter(v => hasPlacement(v, 'home_trailer')),
      home_gameplay: all.filter(v => hasPlacement(v, 'home_gameplay')),
      media_page: all.filter(v => hasPlacement(v, 'media_page')),
      music: all.filter(v => v.mediaType === 'music' || hasPlacement(v, 'music') || hasPlacement(v, 'home_music') || hasPlacement(v, 'media_music')),
      unassigned: all.filter(v => (!v.placements || v.placements.length === 0) && (!v.isAssignedTo || v.isAssignedTo === 'none')),
      dbStatus: getDbStatus()
    };
  }

  return null;
}

module.exports = {
  getS3Config,
  getDbStatus,
  uploadMediaFile,
  uploadImageFile,
  updateVideoThumbnail,
  streamVideoChunk,
  getS3SignedPlaybackUrl,
  getS3UploadPresignedUrl,
  optimizeVideoOnS3,
  parseYouTubeUrl,
  getAllVideos,
  getVideoById,
  addVideo,
  assignVideoPlacement,
  deleteVideo,
  listS3Objects,
  deleteS3ObjectDirect,
  getActivePlacement,
  getSecret
};
