const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const posts = [
  {
    id: 1,
    title: 'Getting Started with Docker',
    date: '2026-09-29',
    excerpt: 'Learn how to containerize your applications for consistent deployments.',
    content: 'Docker simplifies application deployment by packaging your app with all its dependencies into a container. This ensures your app runs the same way in development, staging, and production.'
  },
  {
    id: 2,
    title: 'CI/CD with GitHub Actions',
    date: '2026-09-28',
    excerpt: 'Automate your build, test, and deploy pipeline using GitHub Actions.',
    content: 'GitHub Actions lets you automate workflows directly in your repository. You can build, test, and deploy your code every time you push to your main branch.'
  },
  {
    id: 3,
    title: 'Deploying to AWS EC2',
    date: '2026-09-27',
    excerpt: 'Step-by-step guide to deploying Docker containers on EC2 instances.',
    content: 'AWS EC2 provides scalable virtual servers. By combining EC2 with Docker, you can deploy containerized applications with ease and scale them as needed.'
  },
  {
    id: 4,
    title: 'Live from EC2 - CI/CD Works!',
    date: '2026-09-29',
    excerpt: 'This post proves the full pipeline: push, build, deploy.',
    content: 'If you can read this on the EC2 instance, the GitHub push triggered Docker CI, which pushed to Docker Hub, which triggered Docker CD to deploy here automatically.'
  }
];

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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
