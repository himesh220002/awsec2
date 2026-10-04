const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const videoManager = require('./videoManager');

const SHOWCASE_PATH = path.join(__dirname, '..', 'data', 'showcase.json');

// Blog Mongoose Schema
const BlogSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  slug: { type: String, required: true },
  title: { type: String, required: true },
  date: { type: String, default: () => new Date().toISOString().split('T')[0] },
  author: { type: String, default: 'CypherTech Editorial' },
  category: { type: String, default: 'News' },
  tags: { type: [String], default: [] },
  excerpt: { type: String, required: true },
  content: { type: String, required: true },
  image: { type: String, default: null },
  imageKey: { type: String, default: null },
  featured: { type: Boolean, default: false },
  readTime: { type: Number, default: 1 },
  views: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const Blog = mongoose.models.Blog || mongoose.model('Blog', BlogSchema);

// Helper: load showcase.json fallback
function loadShowcaseFile() {
  try {
    if (fs.existsSync(SHOWCASE_PATH)) {
      return JSON.parse(fs.readFileSync(SHOWCASE_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[BlogManager] Error reading showcase.json:', err.message);
  }
  return { blogs: [] };
}

// Helper: save to showcase.json
function saveShowcaseFile(showcaseData) {
  try {
    fs.writeFileSync(SHOWCASE_PATH, JSON.stringify(showcaseData, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[BlogManager] Error saving showcase.json:', err.message);
    return false;
  }
}

// Word count & read time helper
function calculateReadTime(text, excerpt = '') {
  const words = `${excerpt} ${text}`.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

// Slug generator
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Ensure seeding to Mongo if empty
let isSeeded = false;
async function ensureSeed() {
  if (isSeeded) return;
  try {
    if (mongoose.connection.readyState === 1) {
      const count = await Blog.countDocuments();
      if (count === 0) {
        const sc = loadShowcaseFile();
        if (sc.blogs && sc.blogs.length > 0) {
          console.log('[BlogManager] Seeding MongoDB with showcase blogs...');
          for (const b of sc.blogs) {
            await Blog.create({
              id: b.id,
              slug: b.slug || slugify(b.title),
              title: b.title,
              date: b.date || new Date().toISOString().split('T')[0],
              author: b.author || 'CypherTech Editorial',
              category: b.category || 'News',
              tags: b.tags || [],
              excerpt: b.excerpt || '',
              content: b.content || '',
              image: b.image || null,
              featured: b.id <= 2,
              readTime: calculateReadTime(b.content, b.excerpt)
            });
          }
        }
      }
      isSeeded = true;
    }
  } catch (err) {
    console.warn('[BlogManager] Seed check warning:', err.message);
  }
}

// Get all blogs (MongoDB preferred, fallback to showcase.json)
async function getAllBlogs() {
  await ensureSeed();
  try {
    if (mongoose.connection.readyState === 1) {
      const docs = await Blog.find().sort({ id: -1 }).lean();
      if (docs && docs.length > 0) return docs;
    }
  } catch (err) {
    console.warn('[BlogManager] MongoDB fetch error, falling back to showcase.json:', err.message);
  }

  const sc = loadShowcaseFile();
  return (sc.blogs || []).map(b => ({
    ...b,
    readTime: calculateReadTime(b.content, b.excerpt)
  }));
}

// Get blog by ID
async function getBlogById(id) {
  const numId = parseInt(id, 10);
  try {
    if (mongoose.connection.readyState === 1) {
      const doc = await Blog.findOne({ id: numId }).lean();
      if (doc) return doc;
    }
  } catch (err) {
    console.warn('[BlogManager] MongoDB findOne error:', err.message);
  }

  const sc = loadShowcaseFile();
  return (sc.blogs || []).find(b => b.id === numId) || null;
}

// Create a new blog post
async function createBlog(data, imageFile) {
  let finalImageUrl = data.image || null;
  let finalImageKey = null;

  // If image file uploaded, store to S3 under igv_videos/blogimage/
  if (imageFile && imageFile.buffer) {
    finalImageUrl = await videoManager.uploadBlogImageFile(
      imageFile.buffer,
      imageFile.originalname || 'blog_banner.jpg',
      imageFile.mimetype || 'image/jpeg'
    );
  }

  // Determine next ID
  const all = await getAllBlogs();
  const maxId = all.reduce((max, b) => Math.max(max, Number(b.id) || 0), 0);
  const nextId = maxId + 1;

  const parsedTags = Array.isArray(data.tags)
    ? data.tags
    : typeof data.tags === 'string'
      ? data.tags.split(',').map(t => t.trim()).filter(Boolean)
      : [];

  const blogObj = {
    id: nextId,
    slug: data.slug ? slugify(data.slug) : slugify(data.title),
    title: String(data.title || 'Untitled Dispatch').trim(),
    date: data.date || new Date().toISOString().split('T')[0],
    author: String(data.author || 'CypherTech Editorial').trim(),
    category: String(data.category || 'News').trim(),
    tags: parsedTags.length > 0 ? parsedTags : ['Gaming', 'Intel'],
    excerpt: String(data.excerpt || '').trim(),
    content: String(data.content || '').trim(),
    image: finalImageUrl || '/images/posters/opt/Official_Cover_Art_landscape-1600.webp',
    imageKey: finalImageKey,
    featured: !!data.featured,
    readTime: calculateReadTime(data.content, data.excerpt),
    createdAt: new Date()
  };

  // 1. Save to MongoDB if available
  try {
    if (mongoose.connection.readyState === 1) {
      await Blog.create(blogObj);
    }
  } catch (err) {
    console.warn('[BlogManager] Mongo create warning:', err.message);
  }

  // 2. Persist to data/showcase.json as well for seamless offline/static redundancy
  const sc = loadShowcaseFile();
  if (!sc.blogs) sc.blogs = [];
  sc.blogs.unshift({
    id: blogObj.id,
    slug: blogObj.slug,
    title: blogObj.title,
    date: blogObj.date,
    author: blogObj.author,
    category: blogObj.category,
    tags: blogObj.tags,
    excerpt: blogObj.excerpt,
    image: blogObj.image,
    content: blogObj.content
  });
  saveShowcaseFile(sc);

  return blogObj;
}

// Delete blog by ID
async function deleteBlog(id) {
  const numId = parseInt(id, 10);

  // 1. Delete from MongoDB
  try {
    if (mongoose.connection.readyState === 1) {
      await Blog.deleteOne({ id: numId });
    }
  } catch (err) {
    console.warn('[BlogManager] Mongo delete warning:', err.message);
  }

  // 2. Remove from showcase.json
  const sc = loadShowcaseFile();
  if (sc.blogs) {
    sc.blogs = sc.blogs.filter(b => b.id !== numId);
    saveShowcaseFile(sc);
  }

  return true;
}

// Comment Mongoose Schema for blog field transmissions
const CommentSchema = new mongoose.Schema({
  postId: { type: Number, required: true, index: true },
  author: { type: String, default: 'FieldOperator' },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Comment = mongoose.models.BlogComment || mongoose.model('BlogComment', CommentSchema, 'blog_comments');

const COMMENTS_BACKUP_PATH = path.join(__dirname, '..', 'data', 'blog_comments.json');

function loadCommentsBackup() {
  try {
    if (fs.existsSync(COMMENTS_BACKUP_PATH)) {
      return JSON.parse(fs.readFileSync(COMMENTS_BACKUP_PATH, 'utf8'));
    }
  } catch (e) { }
  return [];
}

function saveCommentsBackup(data) {
  try {
    fs.writeFileSync(COMMENTS_BACKUP_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { }
}

const DEFAULT_COMMENTS = [
  {
    postId: 1,
    author: 'GhostOperator_09',
    message: 'The physics fidelity and weather cycles mentioned here align with the latest game patents. Unreal benchmark expectations!',
    createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  },
  {
    postId: 1,
    author: 'VortexRider',
    message: 'Top quality breakdown. Bookmarked for the upcoming live showcases!',
    createdAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString()
  },
  {
    postId: 2,
    author: 'TenZ_Fanatic',
    message: 'VCT partner stipend model truly stabilized competitive teams through 2024-2025. Glad to see India LAN mentioned!',
    createdAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString()
  },
  {
    postId: 2,
    author: 'TacticalAero',
    message: 'Console release cross-play and mobile testing are going to explode the active player base.',
    createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString()
  }
];

// Get recent 10 comments for a blog post (HTTP Pull from MongoDB)
async function getRecentComments(postId, limit = 10) {
  const numId = parseInt(postId, 10);
  try {
    if (mongoose.connection.readyState === 1) {
      const docs = await Comment.find({ postId: numId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      if (docs && docs.length > 0) return docs;
    }
  } catch (err) {
    console.warn('[BlogManager] Error reading comments from Mongo:', err.message);
  }

  // Backup check
  const allBackup = loadCommentsBackup();
  const matched = allBackup.filter(c => c.postId === numId).slice(0, limit);
  if (matched.length > 0) return matched;

  // Defaults
  const defs = DEFAULT_COMMENTS.filter(c => c.postId === numId).slice(0, limit);
  return defs.length > 0 ? defs : DEFAULT_COMMENTS.slice(0, 2);
}

// Add a comment to MongoDB and trigger unawaited Discord notification
async function addComment(postId, { author, message }) {
  const numId = parseInt(postId, 10);
  const cleanAuthor = (author || 'FieldOperator').trim().replace(/^@/, '');
  const cleanMessage = (message || '').trim();

  let saved = null;
  try {
    if (mongoose.connection.readyState === 1) {
      saved = await Comment.create({
        postId: numId,
        author: cleanAuthor,
        message: cleanMessage,
        createdAt: new Date()
      });
    }
  } catch (err) {
    console.warn('[BlogManager] Mongo comment save failed, using local backup:', err.message);
  }

  const commentObj = {
    _id: saved?._id?.toString() || 'com_' + Date.now(),
    postId: numId,
    author: cleanAuthor,
    message: cleanMessage,
    createdAt: new Date().toISOString()
  };

  const backup = loadCommentsBackup();
  backup.unshift(commentObj);
  saveCommentsBackup(backup.slice(0, 100));

  // Trigger unawaited Discord notification
  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  if (discordUrl) {
    getBlogById(numId).then(blog => {
      const postTitle = blog ? blog.title : `Panel #${numId}`;
      fetch(discordUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'CypherTech Field Log Dispatch',
          avatar_url: 'https://igvictory.com/images/logo.svg',
          embeds: [{
            title: `💬 New Field Transmission on Blog #${numId}`,
            description: `**Post:** ${postTitle}`,
            color: 16723592, // Vice pink
            fields: [
              { name: '👤 Operator', value: `@${cleanAuthor}`, inline: true },
              { name: '💬 Dispatch', value: cleanMessage }
            ],
            footer: { text: 'IGVictory Editorial Field Terminal' },
            timestamp: new Date().toISOString()
          }]
        })
      }).catch(err => console.warn('[BlogManager] Discord webhook error:', err.message));
    }).catch(() => { });
  }

  return saved || commentObj;
}

module.exports = {
  getAllBlogs,
  getBlogById,
  createBlog,
  deleteBlog,
  slugify,
  calculateReadTime,
  getRecentComments,
  addComment
};

