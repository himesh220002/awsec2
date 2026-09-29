const express = require('express');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// gzip / brotli (via Accept-Encoding) for html / json / svg — like Next.js does
app.use(compression({ level: 6, threshold: 1024 }));

// Next/Image-style HTTP caching: immutable 1y for versioned images,
// short for html, day for js/css
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '1y',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      // pages: always revalidate so new deploys show instantly
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (/\.(webp|avif|jpe?g|png|gif|svg|woff2?)$/i.test(filePath)) {
      // optimized images + fonts: immutable year (filenames are content-hashed via -w suffix)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=86400');
    }
  }
}));
app.use(express.json());

const showcase = require('./data/showcase.json');
const posts = showcase.blogs.map(b => ({
  id: b.id,
  slug: b.slug,
  title: b.title,
  date: b.date,
  author: b.author,
  category: b.category,
  tags: b.tags,
  excerpt: b.excerpt,
  content: b.content,
  image: b.image || null
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.get('/media', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'media.html'));
});

app.get('/api/posts', (req, res) => {
  res.json(posts);
});

app.get('/api/posts/:id', (req, res) => {
  const post = posts.find(p => p.id === parseInt(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

app.get('/api/showcase', (req, res) => {
  // small stale-while-revalidate so grids + hero paint fast on repeat visits
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  res.json(showcase);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
