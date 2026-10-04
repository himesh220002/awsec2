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

module.exports = {
  getAllBlogs,
  getBlogById,
  createBlog,
  deleteBlog,
  slugify,
  calculateReadTime
};
