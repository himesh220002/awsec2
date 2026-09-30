require('dotenv').config();
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

// ---- IGDB proxy (server-side only: secrets never reach the browser) ----
let igdbToken = null; // { token, exp }
async function igdbAppToken() {
  if (igdbToken && Date.now() < igdbToken.exp) return igdbToken.token;
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('IGDB credentials missing — set TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET in .env');
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`, { method: 'POST' });
  const t = await r.json();
  if (!t.access_token) throw new Error('IGDB token request failed');
  igdbToken = { token: t.access_token, exp: Date.now() + (t.expires_in - 300) * 1000 };
  return igdbToken.token;
}
async function igdb(path_, query) {
  const token = await igdbAppToken();
  const r = await fetch(`https://api.igdb.com/v4/${path_}`, {
    method: 'POST',
    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
    body: query
  });
  if (!r.ok) { igdbToken = null; throw new Error(`IGDB ${r.status}`); }
  return r.json();
}
const IGDB_FIELDS = 'fields name,summary,cover.image_id,rating,rating_count,genres.name,platforms.abbreviation,first_release_date;';
app.get('/api/igdb/popular', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=3600');
    res.json(await igdb('games', `${IGDB_FIELDS} where rating > 75 & rating_count > 100; sort rating desc; limit 20;`));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/igdb/upcoming', async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=3600');
    res.json(await igdb('games', `${IGDB_FIELDS} where first_release_date > ${now}; sort first_release_date asc; limit 20;`));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// ---- Twitch hub: live streams + gameplay VODs per game (same app token) ----
const twitchCache = new Map(); // key -> { exp, data }
async function fetchTO(url, opts, ms) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally { clearTimeout(to); }
}
async function helix(path, params) {
  const token = await igdbAppToken();
  const q = new URLSearchParams(params).toString();
  const r = await fetchTO(`https://api.twitch.tv/helix/${path}?${q}`, {
    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` }
  }, 12000);
  if (!r.ok) throw new Error(`Twitch ${r.status}`);
  return r.json();
}
// GET /api/twitch/hub?games=Counter-Strike 2,VALORANT,Grand Theft Auto V
app.get('/api/twitch/hub', async (req, res) => {
  try {
    const names = String(req.query.games || 'Counter-Strike,VALORANT,Grand Theft Auto V,PUBG: BATTLEGROUNDS,Forza Horizon 6,Battlefield 6')
      .split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
    const key = names.join('|');
    const hit = twitchCache.get(key);
    if (hit && Date.now() < hit.exp) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
      return res.json(hit.data);
    }
    const out = await Promise.all(names.map(async (name) => {
      try {
        const gj = await helix('games', { name });
        const game = (gj.data || [])[0];
        if (!game) return { name, missing: true };
        const end = new Date(), start = new Date(Date.now() - 7 * 864e5);
        const [sj, cj] = await Promise.all([
          helix('streams', { game_id: game.id, first: '3' }).catch(() => ({ data: [] })),
          helix('clips', { game_id: game.id, first: '4', started_at: start.toISOString(), ended_at: end.toISOString() }).catch(() => ({ data: [] }))
        ]);
        return {
          name: game.name, id: game.id, box: game.box_art_url,
          live: (sj.data || []).map(s => ({
            user: s.user_name, login: s.user_login, title: s.title,
            viewers: s.viewer_count, thumb: s.thumbnail_url, started: s.started_at
          })),
          clips: (cj.data || []).map(c => ({
            id: c.id, title: c.title, user: c.broadcaster_name,
            views: c.view_count, dur: Math.round(c.duration) + 's',
            thumb: c.thumbnail_url, url: c.embed_url
          }))
        };
      } catch (e) { return { name, missing: true }; }
    }));
    const data = out.filter(g => !g.missing);
    twitchCache.set(key, { exp: Date.now() + 60000, data });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/igdb/game/:id', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'numeric id required' });
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=86400');
    const data = await igdb('games', `fields name,summary,storyline,cover.image_id,screenshots.image_id,videos.video_id,rating,rating_count,genres.name,platforms.abbreviation,first_release_date,websites.url; where id = ${req.params.id}; limit 1;`);
    if (!data.length) return res.status(404).json({ error: 'game not found' });
    res.json(data[0]);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
