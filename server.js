const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));
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

app.get('/api/posts', (req, res) => {
  res.json(posts);
});

app.get('/api/posts/:id', (req, res) => {
  const post = posts.find(p => p.id === parseInt(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

app.get('/api/showcase', (req, res) => {
  res.json(showcase);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
