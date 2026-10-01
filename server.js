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

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
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
    const key = `hub:${names.join('|')}`;
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
          helix('streams', { game_id: game.id, first: '4' }).catch(() => ({ data: [] })),
          helix('clips', { game_id: game.id, first: '6', started_at: start.toISOString(), ended_at: end.toISOString() }).catch(() => ({ data: [] }))
        ]);
        const streamData = sj.data || [];
        const uids = [...new Set(streamData.map(s => s.user_id))].slice(0, 3);
        const vLists = await Promise.all(
          uids.map(uid => helix('videos', { user_id: uid, first: '4', type: 'all' }).catch(() => ({ data: [] })))
        );
        const vids = vLists.flatMap(v => v.data || []).map(v => ({
          id: v.id,
          title: v.title,
          user: v.user_name,
          login: v.user_login,
          views: v.view_count,
          dur: v.duration,
          thumb: v.thumbnail_url,
          url: v.url,
          created: v.created_at,
          game: game.name
        }));

        return {
          name: game.name, id: game.id, box: game.box_art_url,
          live: streamData.map(s => ({
            user: s.user_name, login: s.user_login, title: s.title,
            viewers: s.viewer_count, thumb: s.thumbnail_url, started: s.started_at
          })),
          clips: (cj.data || []).map(c => ({
            id: c.id, title: c.title, user: c.broadcaster_name,
            views: c.view_count, dur: Math.round(c.duration) + 's',
            thumb: c.thumbnail_url, url: c.embed_url
          })),
          videos: vids
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

// GET /api/igdb/search?q=query
app.get('/api/igdb/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().replace(/["\\]/g, '');
    if (!q) return res.json([]);
    const key = `igdb:search:${q.toLowerCase()}`;
    const hit = twitchCache.get(key);
    if (hit && Date.now() < hit.exp) {
      res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      return res.json(hit.data);
    }
    const data = await igdb('games', `${IGDB_FIELDS} search "${q}"; limit 12;`);
    twitchCache.set(key, { exp: Date.now() + 300000, data });
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /api/twitch/search?q=valorant&type=all (type: all | game | channel | streamer)
app.get('/api/twitch/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const filter = String(req.query.type || 'all').toLowerCase();
    if (!q) return res.json({ query: '', filter, games: [], channels: [], live: [], clips: [], videos: [] });

    const key = `twitch:search:${filter}:${q.toLowerCase()}`;
    const hit = twitchCache.get(key);
    if (hit && Date.now() < hit.exp) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
      return res.json(hit.data);
    }

    const searchGames = filter === 'all' || filter === 'game' || filter === 'games';
    const searchChannels = filter === 'all' || filter === 'channel' || filter === 'streamer' || filter === 'channels';

    const matchedGames = [];
    const matchedChannels = [];
    const lives = [];
    const clips = [];
    const videos = [];
    const end = new Date(), start = new Date(Date.now() - 30 * 864e5);

    const tasks = [];
    if (searchGames) {
      tasks.push((async () => {
        try {
          const catRes = await helix('search/categories', { query: q, first: '4' }).catch(() => ({ data: [] }));
          let categories = catRes.data || [];
          if (!categories.length) {
            try {
              const cleanQ = q.replace(/["\\]/g, '');
              const igdbGames = await igdb('games', `fields name; search "${cleanQ}"; limit 2;`);
              for (const ig of igdbGames || []) {
                const subCat = await helix('games', { name: ig.name }).catch(() => ({ data: [] }));
                if (subCat.data && subCat.data.length) categories.push(...subCat.data);
              }
            } catch (e) {}
          }
          await Promise.all(categories.map(async (cat) => {
            const [sj, cj] = await Promise.all([
              helix('streams', { game_id: cat.id, first: '6' }).catch(() => ({ data: [] })),
              helix('clips', { game_id: cat.id, first: '6', started_at: start.toISOString(), ended_at: end.toISOString() }).catch(() => ({ data: [] }))
            ]);
            const gLive = (sj.data || []).map(s => ({
              user: s.user_name, login: s.user_login, title: s.title,
              viewers: s.viewer_count, thumb: s.thumbnail_url, started: s.started_at,
              game: cat.name, game_id: cat.id
            }));
            const gClips = (cj.data || []).map(c => ({
              id: c.id, title: c.title, user: c.broadcaster_name,
              views: c.view_count, dur: Math.round(c.duration) + 's',
              thumb: c.thumbnail_url, url: c.embed_url,
              game: cat.name, game_id: cat.id
            }));

            // Fetch VODs/videos from top broadcasters for this category
            const uids = [...new Set((sj.data || []).map(s => s.user_id))].slice(0, 4);
            const vLists = await Promise.all(
              uids.map(uid => helix('videos', { user_id: uid, first: '4', type: 'all' }).catch(() => ({ data: [] })))
            );
            const gVideos = vLists.flatMap(v => v.data || []).map(v => ({
              id: v.id,
              title: v.title,
              user: v.user_name,
              login: v.user_login,
              views: v.view_count,
              dur: v.duration,
              thumb: v.thumbnail_url,
              url: v.url,
              created: v.created_at,
              game: cat.name,
              game_id: cat.id
            }));

            matchedGames.push({
              id: cat.id, name: cat.name, box: cat.box_art_url,
              live: gLive, clips: gClips, videos: gVideos
            });
            lives.push(...gLive);
            clips.push(...gClips);
            videos.push(...gVideos);
          }));
        } catch (e) {}
      })());
    }

    if (searchChannels) {
      tasks.push((async () => {
        try {
          const chanRes = await helix('search/channels', { query: q, first: '6' }).catch(() => ({ data: [] }));
          const channels = chanRes.data || [];
          await Promise.all(channels.map(async (ch) => {
            let liveDetails = null;
            const cTasks = [
              helix('clips', { broadcaster_id: ch.id, first: '4' }).catch(() => ({ data: [] })),
              helix('videos', { user_id: ch.id, first: '6', type: 'all' }).catch(() => ({ data: [] }))
            ];
            if (ch.is_live) {
              cTasks.push(helix('streams', { user_id: ch.id }).catch(() => ({ data: [] })));
            }
            const [cj, vj, sj] = await Promise.all(cTasks);
            if (sj && sj.data && sj.data[0]) {
              const s = sj.data[0];
              liveDetails = {
                user: s.user_name, login: s.user_login, title: s.title,
                viewers: s.viewer_count, thumb: s.thumbnail_url, started: s.started_at,
                game: s.game_name || ch.game_name
              };
              lives.push(liveDetails);
            } else if (ch.is_live) {
              const s = {
                user: ch.display_name, login: ch.broadcaster_login, title: ch.title,
                viewers: 'Live', thumb: ch.thumbnail_url, started: ch.started_at,
                game: ch.game_name
              };
              liveDetails = s;
              lives.push(s);
            }
            const chClips = (cj.data || []).map(c => ({
              id: c.id, title: c.title, user: c.broadcaster_name,
              views: c.view_count, dur: Math.round(c.duration) + 's',
              thumb: c.thumbnail_url, url: c.embed_url,
              game: ch.game_name || 'Twitch'
            }));
            const chVideos = (vj.data || []).map(v => ({
              id: v.id,
              title: v.title,
              user: v.user_name,
              login: v.user_login,
              views: v.view_count,
              dur: v.duration,
              thumb: v.thumbnail_url,
              url: v.url,
              created: v.created_at,
              game: ch.game_name || 'Twitch'
            }));
            clips.push(...chClips);
            videos.push(...chVideos);
            matchedChannels.push({
              id: ch.id, user: ch.display_name, login: ch.broadcaster_login,
              title: ch.title, is_live: ch.is_live, game: ch.game_name,
              avatar: ch.thumbnail_url, liveStream: liveDetails, clips: chClips, videos: chVideos
            });
          }));
        } catch (e) {}
      })());
    }

    await Promise.all(tasks);

    const seenLives = new Set();
    const uniqueLives = lives.filter(l => {
      if (seenLives.has(l.login)) return false;
      seenLives.add(l.login);
      return true;
    }).sort((a, b) => (Number(b.viewers) || 0) - (Number(a.viewers) || 0));

    const seenClips = new Set();
    const uniqueClips = clips.filter(c => {
      if (seenClips.has(c.id)) return false;
      seenClips.add(c.id);
      return true;
    }).sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));

    const seenVideos = new Set();
    const uniqueVideos = videos.filter(v => {
      if (seenVideos.has(v.id)) return false;
      seenVideos.add(v.id);
      return true;
    }).sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));

    const result = {
      query: q,
      filter,
      games: matchedGames,
      channels: matchedChannels,
      live: uniqueLives,
      clips: uniqueClips,
      videos: uniqueVideos
    };

    twitchCache.set(key, { exp: Date.now() + 60000, data: result });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    res.json(result);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /api/twitch/videos?game=Rust or ?channel=shroud or ?user_id=123
app.get('/api/twitch/videos', async (req, res) => {
  try {
    const game = req.query.game ? String(req.query.game).trim() : null;
    const channel = req.query.channel ? String(req.query.channel).trim() : null;
    const userId = req.query.user_id ? String(req.query.user_id).trim() : null;

    const cacheKey = `videos:${game || ''}:${channel || ''}:${userId || ''}`;
    const hit = twitchCache.get(cacheKey);
    if (hit && Date.now() < hit.exp) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
      return res.json(hit.data);
    }

    let userIds = [];
    let gameTitle = game || 'Twitch';

    if (userId) {
      userIds = [userId];
    } else if (channel) {
      const ch = await helix('search/channels', { query: channel, first: 1 }).catch(() => ({ data: [] }));
      if (ch.data && ch.data[0]) userIds = [ch.data[0].id];
    } else if (game) {
      const gRes = await helix('games', { name: game }).catch(() => ({ data: [] }));
      const g = (gRes.data || [])[0];
      if (g) {
        gameTitle = g.name;
        const streams = await helix('streams', { game_id: g.id, first: 8 }).catch(() => ({ data: [] }));
        userIds = [...new Set((streams.data || []).map(s => s.user_id))].slice(0, 6);
      }
    }

    if (!userIds.length) return res.json([]);

    const vLists = await Promise.all(
      userIds.map(uid => helix('videos', { user_id: uid, first: 6, type: 'all' }).catch(() => ({ data: [] })))
    );

    const out = vLists.flatMap(v => v.data || []).map(v => ({
      id: v.id,
      title: v.title,
      user: v.user_name,
      login: v.user_login,
      views: v.view_count,
      dur: v.duration,
      thumb: v.thumbnail_url,
      url: v.url,
      created: v.created_at,
      game: gameTitle
    }));

    const seen = new Set();
    const unique = out.filter(v => {
      if (seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    }).sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));

    twitchCache.set(cacheKey, { exp: Date.now() + 60000, data: unique });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    res.json(unique);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 404 handler
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// 500 handler
app.use((err, req, res, next) => {
  console.error('Internal server error:', err);
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
