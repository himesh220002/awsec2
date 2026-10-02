const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// -------------------------------------------------------------
// Universal Secret & Storage Resolver
// -------------------------------------------------------------
function getSecret(key) {
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return String(process.env[key]).trim();
  }
  try {
    const directPath = path.join('/etc/secrets', key);
    if (fs.existsSync(directPath)) return fs.readFileSync(directPath, 'utf8').trim();
  } catch (e) {}
  try {
    const lowerPath = path.join('/etc/secrets', key.toLowerCase());
    if (fs.existsSync(lowerPath)) return fs.readFileSync(lowerPath, 'utf8').trim();
  } catch (e) {}
  return '';
}

// -------------------------------------------------------------
// Schemas: Hierarchical Tournaments, Multi-Stage Matches, Team Hype
// -------------------------------------------------------------
const TournamentSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  slug: { type: String, index: true },
  game: { 
    type: String, 
    required: true, 
    enum: ['Valorant', 'Counter-Strike 2', 'BGMI', 'League of Legends', 'Call of Duty', 'Dota 2', 'Apex Legends', 'Fortnite'] 
  },
  tier: { type: String, enum: ['S-Tier', 'A-Tier', 'B-Tier', 'Grassroots / LAN'], default: 'S-Tier' },
  organizer: { type: String, default: 'Official' },
  eventFormat: { type: String, enum: ['LAN', 'Online', 'Hybrid'], default: 'LAN' },
  region: { 
    type: String, 
    enum: ['Global', 'India', 'APAC', 'EMEA', 'Americas'], 
    default: 'Global',
    index: true 
  },
  locationDetails: {
    venue: { type: String, default: 'Arena' },
    city: { type: String, default: 'TBA' },
    country: { type: String, default: 'Global' },
    timezone: { type: String, default: 'UTC' }
  },
  prizePool: { type: String, default: '$0' },
  dates: {
    start: { type: Date, required: true },
    end: { type: Date, required: true }
  },
  stages: [{
    stageId: { type: String },
    name: { type: String },
    isActive: { type: Boolean, default: false }
  }],
  status: { 
    type: String, 
    enum: ['upcoming', 'live', 'completed'], 
    default: 'upcoming',
    index: true 
  },
  streamUrls: {
    primary: { type: String, default: '' },
    regional_hi: { type: String, default: '' },
    secondary: { type: String, default: '' }
  },
  community: {
    discord: { type: String, default: '' },
    reddit: { type: String, default: '' },
    calendarUrl: { type: String, default: '' }
  },
  featured: { type: Boolean, default: false }
}, { timestamps: true, collection: 'tournaments', strict: false });

const MatchSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  tournamentId: { type: String, index: true, required: true },
  tournamentName: { type: String, default: '' },
  game: { type: String, default: '' },
  stageId: { type: String, default: '' },
  round: { type: String, default: 'Final' },
  scheduledAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['upcoming', 'live', 'completed'], default: 'upcoming', index: true },
  teamA: {
    id: { type: String, default: '' },
    name: { type: String, required: true },
    tag: { type: String, uppercase: true },
    logo: { type: String, default: '/images/teams/default.png' },
    score: { type: Number, default: 0 }
  },
  teamB: {
    id: { type: String, default: '' },
    name: { type: String, required: true },
    tag: { type: String, uppercase: true },
    logo: { type: String, default: '/images/teams/default.png' },
    score: { type: Number, default: 0 }
  },
  currentMap: { type: String, default: '' },
  streamUrl: { type: String, default: '' },
  votes: {
    teamA: { type: Number, default: 0 },
    teamB: { type: Number, default: 0 }
  },
  winner: { type: String, default: null }
}, { timestamps: true, collection: 'matches' });

const TeamHypeSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  tag: { type: String, uppercase: true },
  game: { type: String, required: true },
  region: { type: String, default: 'Global' },
  logo: { type: String, default: '' },
  hypeScore: { type: Number, default: 0, index: -1 },
  socials: {
    twitter: { type: String, default: '' },
    instagram: { type: String, default: '' },
    youtube: { type: String, default: '' }
  }
}, { timestamps: true, collection: 'team_hypes' });

const Tournament = mongoose.models.Tournament || mongoose.model('Tournament', TournamentSchema);
const Match = mongoose.models.Match || mongoose.model('Match', MatchSchema);
const TeamHype = mongoose.models.TeamHype || mongoose.model('TeamHype', TeamHypeSchema);

// -------------------------------------------------------------
// Initial Seeds (Tier-1 Global + India Regional LAN Circuits)
// -------------------------------------------------------------
const seedTournaments = [
  {
    _id: 't_vct_masters_toronto',
    name: 'VCT Masters Toronto 2026',
    slug: 'vct-masters-toronto-2026',
    game: 'Valorant',
    tier: 'S-Tier',
    organizer: 'Riot Games',
    eventFormat: 'LAN',
    region: 'Global',
    locationDetails: {
      venue: 'Scotiabank Arena',
      city: 'Toronto',
      country: 'Canada',
      timezone: 'America/Toronto'
    },
    prizePool: '$1,000,000',
    dates: {
      start: new Date('2026-06-10T16:00:00Z'),
      end: new Date('2026-06-25T23:59:59Z')
    },
    stages: [
      { stageId: 'stg_swiss', name: 'Swiss Stage', isActive: false },
      { stageId: 'stg_playoffs', name: 'Knockout Bracket', isActive: true }
    ],
    status: 'live',
    streamUrls: {
      primary: 'https://twitch.tv/valorant',
      secondary: 'https://youtube.com/@valorantesports'
    },
    community: {
      discord: 'https://discord.gg/valorant',
      reddit: 'https://reddit.com/r/ValorantCompetitive'
    },
    featured: true
  },
  {
    _id: 't_bgmi_pro_series_2026',
    name: 'Battlegrounds Mobile India Series (BGIS) 2026',
    slug: 'bgis-2026-grand-finals',
    game: 'BGMI',
    tier: 'S-Tier',
    organizer: 'Krafton India Esports',
    eventFormat: 'LAN',
    region: 'India',
    locationDetails: {
      venue: 'Hitex Exhibition Center',
      city: 'Hyderabad',
      country: 'India',
      timezone: 'Asia/Kolkata'
    },
    prizePool: '₹2,00,00,000',
    dates: {
      start: new Date('2026-05-15T08:00:00Z'),
      end: new Date('2026-06-02T18:00:00Z')
    },
    stages: [
      { stageId: 'stg_semi', name: 'Semi Finals (32 Teams)', isActive: false },
      { stageId: 'stg_grand', name: 'Grand Finals (16 Teams)', isActive: true }
    ],
    status: 'live',
    streamUrls: {
      primary: 'https://youtube.com/@KraftonIndiaEsports',
      regional_hi: 'https://youtube.com/@KraftonIndiaEsports'
    },
    community: {
      discord: 'https://discord.gg/bgmi',
      reddit: 'https://reddit.com/r/BGMIEsports'
    },
    featured: true
  },
  {
    _id: 't_cs2_austin_major_2026',
    name: 'PGL CS2 Austin Major 2026',
    slug: 'pgl-cs2-austin-major-2026',
    game: 'Counter-Strike 2',
    tier: 'S-Tier',
    organizer: 'PGL / Valve',
    eventFormat: 'LAN',
    region: 'Global',
    locationDetails: {
      venue: 'Moody Center',
      city: 'Austin, Texas',
      country: 'USA',
      timezone: 'America/Chicago'
    },
    prizePool: '$1,250,000',
    dates: {
      start: new Date('2026-07-02T15:00:00Z'),
      end: new Date('2026-07-15T22:00:00Z')
    },
    stages: [
      { stageId: 'stg_challengers', name: 'Opening Stage', isActive: false },
      { stageId: 'stg_champions', name: 'Champions Stage', isActive: true }
    ],
    status: 'upcoming',
    streamUrls: {
      primary: 'https://twitch.tv/pgl',
      secondary: 'https://youtube.com/@PGL'
    },
    community: {
      discord: 'https://discord.gg/cs2',
      reddit: 'https://reddit.com/r/GlobalOffensive'
    },
    featured: true
  },
  {
    _id: 't_lol_worlds_2026',
    name: 'League of Legends World Championship 2026',
    slug: 'lol-worlds-2026',
    game: 'League of Legends',
    tier: 'S-Tier',
    organizer: 'Riot Games',
    eventFormat: 'LAN',
    region: 'Global',
    locationDetails: {
      venue: 'Mercedes-Benz Arena',
      city: 'Berlin',
      country: 'Germany',
      timezone: 'Europe/Berlin'
    },
    prizePool: '$2,225,000',
    dates: {
      start: new Date('2026-10-10T12:00:00Z'),
      end: new Date('2026-11-08T20:00:00Z')
    },
    stages: [
      { stageId: 'stg_playin', name: 'Play-In Stage', isActive: true },
      { stageId: 'stg_knockout', name: 'Knockout Stage', isActive: false }
    ],
    status: 'upcoming',
    streamUrls: {
      primary: 'https://twitch.tv/riotgames',
      secondary: 'https://youtube.com/@lolesports'
    },
    community: {
      discord: 'https://discord.gg/lolesports',
      reddit: 'https://reddit.com/r/leagueoflegends'
    },
    featured: true
  }
];

const seedMatches = [
  {
    _id: 'm_sen_prx',
    tournamentId: 't_vct_masters_toronto',
    tournamentName: 'VCT Masters Toronto',
    game: 'Valorant',
    stageId: 'stg_playoffs',
    round: 'Upper Bracket Final (BO3)',
    scheduledAt: new Date(Date.now() - 35 * 60 * 1000),
    status: 'live',
    teamA: {
      id: 'team_sen',
      name: 'Sentinels',
      tag: 'SEN',
      logo: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=128&q=80',
      score: 1
    },
    teamB: {
      id: 'team_prx',
      name: 'Paper Rex',
      tag: 'PRX',
      logo: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=128&q=80',
      score: 1
    },
    currentMap: 'Map 3 — Lotus (Round 11 - 10)',
    streamUrl: 'https://twitch.tv/valorant',
    votes: { teamA: 1450, teamB: 1210 },
    winner: null
  },
  {
    _id: 'm_godlike_soul',
    tournamentId: 't_bgmi_pro_series_2026',
    tournamentName: 'BGIS Grand Finals 2026',
    game: 'BGMI',
    stageId: 'stg_grand',
    round: 'Grand Finals — Match 5 (Erangel)',
    scheduledAt: new Date(Date.now() + 45 * 60 * 1000),
    status: 'upcoming',
    teamA: {
      id: 'team_godlike',
      name: 'GodLike Esports',
      tag: 'GODL',
      logo: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=128&q=80',
      score: 0
    },
    teamB: {
      id: 'team_soul',
      name: 'Team Soul',
      tag: 'SOUL',
      logo: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=128&q=80',
      score: 0
    },
    currentMap: 'Map 5 — Erangel Day 3',
    streamUrl: 'https://youtube.com/@KraftonIndiaEsports',
    votes: { teamA: 3840, teamB: 4120 },
    winner: null
  },
  {
    _id: 'm_navi_faze',
    tournamentId: 't_cs2_austin_major_2026',
    tournamentName: 'PGL CS2 Austin Major',
    game: 'Counter-Strike 2',
    stageId: 'stg_champions',
    round: 'Quarterfinals (BO3)',
    scheduledAt: new Date(Date.now() + 3 * 3600 * 1000),
    status: 'upcoming',
    teamA: {
      id: 'team_navi',
      name: 'Natus Vincere',
      tag: 'NAVI',
      logo: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=128&q=80',
      score: 0
    },
    teamB: {
      id: 'team_faze',
      name: 'FaZe Clan',
      tag: 'FAZE',
      logo: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=128&q=80',
      score: 0
    },
    currentMap: 'Mirage / Inferno / Nuke',
    streamUrl: 'https://twitch.tv/pgl',
    votes: { teamA: 2140, teamB: 1980 },
    winner: null
  },
  {
    _id: 'm_t1_geng',
    tournamentId: 't_lol_worlds_2026',
    tournamentName: 'LoL World Championship',
    game: 'League of Legends',
    stageId: 'stg_playin',
    round: 'Opening Showdown (BO5)',
    scheduledAt: new Date(Date.now() + 18 * 3600 * 1000),
    status: 'upcoming',
    teamA: {
      id: 'team_t1',
      name: 'T1',
      tag: 'T1',
      logo: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=128&q=80',
      score: 0
    },
    teamB: {
      id: 'team_geng',
      name: 'Gen.G',
      tag: 'GEN',
      logo: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=128&q=80',
      score: 0
    },
    currentMap: "Summoner's Rift",
    streamUrl: 'https://twitch.tv/riotgames',
    votes: { teamA: 5210, teamB: 4890 },
    winner: null
  }
];

const seedTeams = [
  { _id: 'team_soul', name: 'Team Soul', tag: 'SOUL', game: 'BGMI', region: 'India', hypeScore: 25420, logo: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=128&q=80' },
  { _id: 'team_godlike', name: 'GodLike Esports', tag: 'GODL', game: 'BGMI', region: 'India', hypeScore: 24190, logo: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=128&q=80' },
  { _id: 'team_prx', name: 'Paper Rex', tag: 'PRX', game: 'Valorant', region: 'APAC', hypeScore: 19840, logo: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=128&q=80' },
  { _id: 'team_sen', name: 'Sentinels', tag: 'SEN', game: 'Valorant', region: 'Americas', hypeScore: 19120, logo: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=128&q=80' },
  { _id: 'team_t1', name: 'T1', tag: 'T1', game: 'League of Legends', region: 'APAC', hypeScore: 17850, logo: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=128&q=80' },
  { _id: 'team_navi', name: 'Natus Vincere', tag: 'NAVI', game: 'Counter-Strike 2', region: 'EMEA', hypeScore: 15410, logo: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=128&q=80' },
  { _id: 'team_faze', name: 'FaZe Clan', tag: 'FAZE', game: 'Counter-Strike 2', region: 'Americas', hypeScore: 14380, logo: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=128&q=80' }
];

// Fallback in-memory copies from showcase.json (real scraped data) + seeds
function loadDynamicTournaments() {
  try {
    const scPath = path.join(__dirname, '..', 'data', 'showcase.json');
    if (fs.existsSync(scPath)) {
      const parsed = JSON.parse(fs.readFileSync(scPath, 'utf8'));
      if (Array.isArray(parsed.events) && parsed.events.length) {
        return parsed.events.map(ev => ({
          _id: ev.id || ev._id || 't_' + (ev.slug || ev.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')),
          name: ev.name,
          slug: ev.slug || ev.id || ev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          game: ev.game,
          tier: 'S-Tier',
          organizer: ev.source || ev.organizer || 'Official',
          eventFormat: ev.format?.includes('LAN') ? 'LAN' : 'LAN',
          region: (ev.location?.includes('India') || ev.game === 'BGMI') ? 'India' : 'Global',
          locationDetails: {
            venue: ev.location || 'Official Arena',
            city: ev.location || 'TBA',
            country: (ev.location?.includes('India') || ev.game === 'BGMI') ? 'India' : 'Global',
            timezone: 'UTC'
          },
          prizePool: ev.prizePool || ev.prize || '$1,000,000',
          dates: {
            start: new Date(ev.start || ev.date || Date.now()),
            end: new Date(ev.end || ev.date || Date.now() + 14 * 86400000)
          },
          stages: (ev.stages || []).map((s, idx) => ({
            stageId: 'stg_' + idx,
            name: s.name,
            isActive: s.status === 'live'
          })),
          status: ev.status || 'completed',
          streamUrls: { primary: ev.url || '', secondary: '' },
          community: { discord: '', reddit: '' },
          featured: true,
          about: ev.about || ev.desc || '',
          winner: ev.winner || null,
          standings: ev.standings || [],
          news: ev.news || []
        })).sort((a, b) => {
          const sp = { live: 0, upcoming: 1, completed: 2 };
          const sDiff = (sp[a.status] ?? 1) - (sp[b.status] ?? 1);
          if (sDiff !== 0) return sDiff;
          return new Date(b.dates.start).getTime() - new Date(a.dates.start).getTime();
        });
      }
    }
  } catch (e) {
    console.warn('[TournamentManager] Failed to load dynamic tournaments:', e.message);
  }
  return [];
}

const dynamicTourneys = loadDynamicTournaments();
let fallbackTournaments = dynamicTourneys.length ? dynamicTourneys : [...seedTournaments];
let fallbackMatches = [...seedMatches];
let fallbackTeams = [...seedTeams];

// -------------------------------------------------------------
// Database Connection & Seeding
// -------------------------------------------------------------
let isMongoConnected = false;
let mongoPromise = null;

async function ensureMongo() {
  if (mongoose.connection.readyState === 1) {
    isMongoConnected = true;
    return true;
  }
  const mongoUri = getSecret('MONGO_URI');
  if (!mongoUri) return false;

  if (!mongoPromise) {
    mongoPromise = mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000
    }).then(async () => {
      isMongoConnected = true;
      console.log('[TournamentManager] Connected to MongoDB Atlas cluster');
      setTimeout(seedIfEmpty, 500);
      return true;
    }).catch(err => {
      mongoPromise = null;
      isMongoConnected = false;
      console.warn('[TournamentManager] MongoDB warning:', err.message);
      return false;
    });
  }
  return mongoPromise;
}

async function seedIfEmpty() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const tCount = await Tournament.countDocuments();
    if (tCount === 0) {
      console.log('[TournamentManager] Seeding tournaments into MongoDB...');
      await Tournament.insertMany(seedTournaments);
    }
    const mCount = await Match.countDocuments();
    if (mCount === 0) {
      console.log('[TournamentManager] Seeding matches into MongoDB...');
      await Match.insertMany(seedMatches);
    }
    const thCount = await TeamHype.countDocuments();
    if (thCount === 0) {
      console.log('[TournamentManager] Seeding team hypes into MongoDB...');
      await TeamHype.insertMany(seedTeams);
    }
  } catch (err) {
    console.warn('[TournamentManager] Seeding note:', err.message);
  }
}

mongoose.connection.on('connected', () => {
  isMongoConnected = true;
  setTimeout(seedIfEmpty, 1000);
});

ensureMongo();

// -------------------------------------------------------------
// High-Throughput Write-Buffer & Periodic Debounced Flush
// -------------------------------------------------------------
const memoryBuffer = {
  votes: new Map(), // matchId -> { teamA: number, teamB: number, deltaA: number, deltaB: number, dirty: boolean }
  hypes: new Map()  // teamId -> { score: number, delta: number, dirty: boolean }
};

// Periodic flush every 5 seconds
setInterval(async () => {
  if (!isMongoConnected) return;

  for (const [matchId, v] of memoryBuffer.votes.entries()) {
    if (v.dirty && (v.deltaA > 0 || v.deltaB > 0)) {
      v.dirty = false;
      const dA = v.deltaA;
      const dB = v.deltaB;
      v.deltaA = 0;
      v.deltaB = 0;

      await Match.findByIdAndUpdate(matchId, {
        $inc: { 'votes.teamA': dA, 'votes.teamB': dB }
      }).catch(e => console.warn('[Buffer] Vote flush error:', e.message));
    }
  }

  for (const [teamId, h] of memoryBuffer.hypes.entries()) {
    if (h.dirty && h.delta > 0) {
      h.dirty = false;
      const delta = h.delta;
      h.delta = 0;

      await TeamHype.findByIdAndUpdate(teamId, {
        $inc: { hypeScore: delta }
      }).catch(e => console.warn('[Buffer] Hype flush error:', e.message));
    }
  }
}, 5000);

// -------------------------------------------------------------
// Public Query & Mutation Methods
// -------------------------------------------------------------

// 1. Get Tournaments (Supports filter: region, game, status)
async function getTournaments({ region, game, status } = {}) {
  await ensureMongo();

  const filter = {};
  if (region && region !== 'All') filter.region = region;
  if (game && game !== 'All') filter.game = game;
  if (status && status !== 'All') filter.status = status;

  let list = [];
  if (isMongoConnected) {
    try {
      list = await Tournament.find(filter).sort({ 'dates.start': -1 }).lean();
    } catch (e) {
      console.warn('[TournamentManager] Mongo getTournaments fallback:', e.message);
    }
  }

  if (!list || list.length === 0) {
    list = fallbackTournaments.filter(t => {
      if (filter.region && t.region !== filter.region) return false;
      if (filter.game && t.game !== filter.game) return false;
      if (filter.status && t.status !== filter.status) return false;
      return true;
    });
  }

  const statusPriority = { live: 0, upcoming: 1, completed: 2 };
  return list.sort((a, b) => {
    const spA = statusPriority[a.status] ?? 1;
    const spB = statusPriority[b.status] ?? 1;
    if (spA !== spB) return spA - spB;
    const da = new Date(a.dates?.start || a.start || a.date || 0).getTime();
    const db = new Date(b.dates?.start || b.start || b.date || 0).getTime();
    return db - da; // latest start date first (2026 up in front, older behind)
  });
}

// 2. Get Tournament by ID
async function getTournamentById(id) {
  await ensureMongo();
  if (isMongoConnected) {
    try {
      const t = await Tournament.findById(id).lean();
      if (t) return t;
    } catch (e) {}
  }
  return fallbackTournaments.find(t => t._id === id) || null;
}

// 3. Get Matches (Matches with live memory buffer vote overlay)
async function getMatches({ tournamentId, status, limit = 20 } = {}) {
  await ensureMongo();
  const filter = {};
  if (tournamentId) filter.tournamentId = tournamentId;
  if (status) filter.status = status;

  let list = [];
  if (isMongoConnected) {
    try {
      list = await Match.find(filter).sort({ scheduledAt: 1 }).limit(Number(limit)).lean();
    } catch (e) {
      console.warn('[TournamentManager] Mongo getMatches fallback:', e.message);
    }
  }

  if (!list || list.length === 0) {
    list = fallbackMatches.filter(m => {
      if (filter.tournamentId && m.tournamentId !== filter.tournamentId) return false;
      if (filter.status && m.status !== filter.status) return false;
      return true;
    }).slice(0, Number(limit));
  }

  // Overlay real-time memory buffer delta
  return list.map(m => {
    const mem = memoryBuffer.votes.get(m._id);
    const votesA = (m.votes?.teamA || 0) + (mem?.deltaA || 0);
    const votesB = (m.votes?.teamB || 0) + (mem?.deltaB || 0);
    const total = votesA + votesB;
    return {
      ...m,
      votes: {
        teamA: votesA,
        teamB: votesB,
        total,
        teamA_pct: Math.round((votesA / (total || 1)) * 100),
        teamB_pct: Math.round((votesB / (total || 1)) * 100)
      }
    };
  });
}

// 4. Lightweight Fast-Path Ticker (for header ticker bar)
async function getTickerData() {
  await ensureMongo();
  const matches = await getMatches({ limit: 8 });
  const live = matches.filter(m => m.status === 'live');
  const upcoming = matches.filter(m => m.status === 'upcoming');
  return {
    live,
    upcoming,
    count: matches.length
  };
}

// 5. Zero-Lag Pick'em Vote
async function recordVote(matchId, selectedTeam) {
  if (!matchId || !['teamA', 'teamB'].includes(selectedTeam)) {
    throw new Error('Invalid matchId or selectedTeam');
  }

  let mem = memoryBuffer.votes.get(matchId);
  if (!mem) {
    const match = await Match.findById(matchId).lean().catch(() => null);
    const baseA = match?.votes?.teamA || 10;
    const baseB = match?.votes?.teamB || 10;
    mem = { teamA: baseA, teamB: baseB, deltaA: 0, deltaB: 0, dirty: false };
    memoryBuffer.votes.set(matchId, mem);
  }

  if (selectedTeam === 'teamA') {
    mem.teamA += 1;
    mem.deltaA += 1;
  } else {
    mem.teamB += 1;
    mem.deltaB += 1;
  }
  mem.dirty = true;

  // Also update local fallback
  const localMatch = fallbackMatches.find(m => m._id === matchId);
  if (localMatch) {
    if (!localMatch.votes) localMatch.votes = { teamA: 0, teamB: 0 };
    localMatch.votes[selectedTeam] += 1;
  }

  const total = mem.teamA + mem.teamB;
  return {
    success: true,
    matchId,
    votes: {
      teamA: mem.teamA,
      teamB: mem.teamB,
      total,
      teamA_pct: Math.round((mem.teamA / total) * 100),
      teamB_pct: Math.round((mem.teamB / total) * 100)
    }
  };
}

// 6. Team Hype Leaderboard
async function getTeamHypes(limit = 10) {
  await ensureMongo();
  let list = [];
  if (isMongoConnected) {
    try {
      list = await TeamHype.find().sort({ hypeScore: -1 }).limit(Number(limit)).lean();
    } catch (e) {}
  }
  if (!list || list.length === 0) {
    list = [...fallbackTeams].sort((a, b) => b.hypeScore - a.hypeScore).slice(0, Number(limit));
  }

  // Overlay memory buffer
  return list.map(t => {
    const mem = memoryBuffer.hypes.get(t._id);
    return {
      ...t,
      hypeScore: (t.hypeScore || 0) + (mem?.delta || 0)
    };
  }).sort((a, b) => b.hypeScore - a.hypeScore);
}

// 7. Team Hype Accelerator Click
async function recordTeamHype(teamId) {
  if (!teamId) throw new Error('teamId required');

  let mem = memoryBuffer.hypes.get(teamId);
  if (!mem) {
    const team = await TeamHype.findById(teamId).lean().catch(() => null);
    mem = { score: team?.hypeScore || 100, delta: 0, dirty: false };
    memoryBuffer.hypes.set(teamId, mem);
  }

  mem.score += 1;
  mem.delta += 1;
  mem.dirty = true;

  const localTeam = fallbackTeams.find(t => t._id === teamId);
  if (localTeam) localTeam.hypeScore = (localTeam.hypeScore || 0) + 1;

  return {
    success: true,
    teamId,
    newHypeScore: mem.score
  };
}

// 8. Admin Creator Protocols (for manual custom cups & LAN brackets)
async function createTournament(data) {
  await ensureMongo();
  const id = data._id || 't_' + Date.now().toString(36);
  const record = { ...data, _id: id };

  fallbackTournaments.unshift(record);
  if (isMongoConnected) {
    try {
      const created = await Tournament.create(record);
      return created.toObject();
    } catch (e) {
      console.warn('[TournamentManager] Mongo createTournament error:', e.message);
    }
  }
  return record;
}

async function createMatch(data) {
  await ensureMongo();
  const id = data._id || 'm_' + Date.now().toString(36);
  const record = { ...data, _id: id };

  fallbackMatches.unshift(record);
  if (isMongoConnected) {
    try {
      const created = await Match.create(record);
      return created.toObject();
    } catch (e) {
      console.warn('[TournamentManager] Mongo createMatch error:', e.message);
    }
  }
  return record;
}

async function updateMatchScore(matchId, { scoreA, scoreB, currentMap, status, winner }) {
  await ensureMongo();
  const update = {};
  if (scoreA !== undefined) update['teamA.score'] = Number(scoreA);
  if (scoreB !== undefined) update['teamB.score'] = Number(scoreB);
  if (currentMap !== undefined) update.currentMap = currentMap;
  if (status !== undefined) update.status = status;
  if (winner !== undefined) update.winner = winner;

  let updated = null;
  if (isMongoConnected) {
    try {
      updated = await Match.findByIdAndUpdate(matchId, { $set: update }, { returnDocument: 'after' }).lean();
    } catch (e) {}
  }

  const local = fallbackMatches.find(m => m._id === matchId);
  if (local) {
    if (scoreA !== undefined) local.teamA.score = Number(scoreA);
    if (scoreB !== undefined) local.teamB.score = Number(scoreB);
    if (currentMap !== undefined) local.currentMap = currentMap;
    if (status !== undefined) local.status = status;
    if (winner !== undefined) local.winner = winner;
    if (!updated) updated = local;
  }

  return updated;
}

module.exports = {
  getTournaments,
  getTournamentById,
  getMatches,
  getTickerData,
  recordVote,
  getTeamHypes,
  recordTeamHype,
  createTournament,
  createMatch,
  updateMatchScore
};
