const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
  // Multiple selection placements: e.g. ['home_trailer', 'home_gameplay', 'media_page']
  placements: {
    type: [String],
    enum: ['home_trailer', 'home_gameplay', 'media_page'],
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

// Connect to MongoDB if MONGO_URI is set
async function initMongo() {
  const mongoUri = getSecret('MONGO_URI');
  if (!mongoUri) {
    console.log('[MediaManager] No MONGO_URI set; using local JSON database.');
    return false;
  }

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000
    });
    isMongoConnected = true;
    console.log('[MediaManager] Connected to MongoDB Atlas cluster (igvDB.videos)');

    // Seed default records if collection is completely empty
    const count = await Video.countDocuments();
    if (count === 0 && fallbackVideos.length > 0) {
      console.log(`[MediaManager] Seeding ${fallbackVideos.length} initial videos into MongoDB...`);
      for (const v of fallbackVideos) {
        const pArray = Array.isArray(v.placements)
          ? v.placements
          : (v.isAssignedTo && v.isAssignedTo !== 'none' ? [v.isAssignedTo] : []);
        await Video.create({
          _id: v._id || new mongoose.Types.ObjectId().toString(),
          title: v.title,
          type: v.type,
          sourceUrl: v.sourceUrl,
          fileKey: v.fileKey || null,
          youtubeId: v.youtubeId || null,
          thumbnail: v.thumbnail || null,
          placements: pArray,
          isAssignedTo: v.isAssignedTo || (pArray[0] || 'none'),
          uploadedAt: v.uploadedAt ? new Date(v.uploadedAt) : new Date()
        });
      }
      console.log('[MediaManager] Seeding complete.');
    }

    return true;
  } catch (err) {
    console.warn('[MediaManager] MongoDB connection warning:', err.message);
    isMongoConnected = false;
    return false;
  }
}

mongoose.connection.on('connected', () => {
  isMongoConnected = true;
});
mongoose.connection.on('disconnected', () => {
  isMongoConnected = false;
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
  const fileKey = `igv_videos/${Date.now()}_${cleanBase}${ext}`;

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

  if (s3 && fileKey && fileKey.startsWith('igv_videos/')) {
    try {
      // 1. Query metadata for Content-Length and Content-Type
      const head = await s3.send(new HeadObjectCommand({
        Bucket: s3Config.bucket,
        Key: fileKey
      }));

      const totalSize = head.ContentLength;
      const contentType = head.ContentType || 'video/mp4';
      const range = req.headers.range;
      const CHUNK_SIZE = 1024 * 1024 * 2; // 2MB chunk window

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        let end = parts[1] ? parseInt(parts[1], 10) : start + CHUNK_SIZE - 1;
        if (end >= totalSize) end = totalSize - 1;

        const contentLength = end - start + 1;
        const s3Range = `bytes=${start}-${end}`;

        const s3Obj = await s3.send(new GetObjectCommand({
          Bucket: s3Config.bucket,
          Key: fileKey,
          Range: s3Range
        }));

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': contentLength,
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
        });

        return s3Obj.Body.pipe(res);
      } else {
        // Send initial chunk
        const end = Math.min(CHUNK_SIZE - 1, totalSize - 1);
        const s3Obj = await s3.send(new GetObjectCommand({
          Bucket: s3Config.bucket,
          Key: fileKey,
          Range: `bytes=0-${end}`
        }));

        res.writeHead(206, {
          'Content-Range': `bytes 0-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end + 1,
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400'
        });

        return s3Obj.Body.pipe(res);
      }
    } catch (err) {
      console.error('[MediaManager] S3 Range Stream Error, falling back to presigned redirect:', err.message);
      const signed = await getS3SignedPlaybackUrl(fileKey, 3600);
      if (signed) return res.redirect(signed);
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

// Upload buffer to AWS S3 (under igv_videos/) or fallback to local disk
async function uploadMediaFile(fileBuffer, originalName, mimeType) {
  const s3Config = getS3Config();
  const s3 = getS3Client();
  const ext = path.extname(originalName) || '.mp4';
  const cleanBase = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileKey = `igv_videos/${Date.now()}_${cleanBase}${ext}`;

  if (s3) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: fileKey,
        Body: fileBuffer,
        ContentType: mimeType || 'video/mp4'
      }));

      // Stream URL ensures chunked byte-range retrieval works with 100% reliability
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
    fs.writeFileSync(localFilePath, fileBuffer);

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
  return o;
}

async function getAllVideos() {
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

async function addVideo({ title, type, sourceUrl, fileKey, youtubeId, thumbnail, placements }) {
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
  const validPlacements = ['home_trailer', 'home_gameplay', 'media_page'];
  let pArray = [];
  if (Array.isArray(placements)) {
    pArray = placements.filter(p => validPlacements.includes(p));
  } else if (typeof placements === 'string' && validPlacements.includes(placements)) {
    pArray = [placements];
  }

  const primaryPlacement = pArray[0] || 'none';

  const record = {
    _id: newId,
    title: title || 'Untitled Broadcast',
    type: type === 's3' ? 's3' : 'youtube',
    sourceUrl: sourceUrl || '',
    fileKey: fileKey || null,
    youtubeId: youtubeId || null,
    thumbnail: thumbnail || (type === 's3' ? '/images/posters/poster_full.0az_iud2g3y4j.jpg' : null),
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
  const validPlacements = ['home_trailer', 'home_gameplay', 'media_page'];

  let newPlacements = [];
  const existingVideo = await getVideoById(videoId);
  if (!existingVideo) throw new Error(`Video not found with id ${videoId}`);

  const currentPlacements = Array.isArray(existingVideo.placements) ? [...existingVideo.placements] : [];

  if (Array.isArray(targetPlacement)) {
    // Array of placements provided directly
    newPlacements = targetPlacement.filter(p => validPlacements.includes(p));
  } else if (typeof targetPlacement === 'object' && targetPlacement.placements) {
    newPlacements = targetPlacement.placements.filter(p => validPlacements.includes(p));
  } else if (typeof targetPlacement === 'string') {
    if (targetPlacement === 'none' || targetPlacement === 'unassign') {
      newPlacements = [];
    } else if (options.toggle !== undefined) {
      // Toggle a specific placement on or off
      if (options.toggle) {
        newPlacements = Array.from(new Set([...currentPlacements, targetPlacement]));
      } else {
        newPlacements = currentPlacements.filter(p => p !== targetPlacement);
      }
    } else if (validPlacements.includes(targetPlacement)) {
      // Direct set
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

  // Update in-memory / JSON fallback
  const local = fallbackVideos.find(v => String(v._id) === String(videoId) || String(v.id) === String(videoId));
  if (local) {
    local.placements = newPlacements;
    local.isAssignedTo = primaryPlacement;
    saveDb();
    if (!updatedVideo) updatedVideo = { ...local };
  }

  return updatedVideo;
}

async function deleteVideo(videoId) {
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

  return deleted;
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
    // Primary active trailer
    return all.find(v => hasPlacement(v, 'home_trailer')) || null;
  }
  if (placement === 'home_gameplay') {
    // Elastic list of ALL gameplay showcase videos (no hardcoded limits)
    return all.filter(v => hasPlacement(v, 'home_gameplay'));
  }
  if (placement === 'media_page') {
    // Elastic list of media vault videos
    return all.filter(v => hasPlacement(v, 'media_page'));
  }
  if (placement === 'all') {
    return {
      home_trailer: all.find(v => hasPlacement(v, 'home_trailer')) || null,
      home_trailers: all.filter(v => hasPlacement(v, 'home_trailer')),
      home_gameplay: all.filter(v => hasPlacement(v, 'home_gameplay')),
      media_page: all.filter(v => hasPlacement(v, 'media_page')),
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
  parseYouTubeUrl,
  getAllVideos,
  getVideoById,
  addVideo,
  assignVideoPlacement,
  deleteVideo,
  getActivePlacement,
  getSecret
};
