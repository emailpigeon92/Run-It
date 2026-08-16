/* Vercel serverless function: album artwork lookup.
 *
 * POST /api/art   { tracks: [{ artist, track, album }] }
 * →               { art: { "artist|track": "data:image/jpeg;base64,…" }, misses: n }
 *
 * Returns base64 data URIs rather than URLs on purpose. The card is exported to
 * PNG by drawing the SVG onto a canvas, and a canvas containing a cross-origin
 * image is "tainted" — toBlob() then throws and PNG export dies. Inlining the
 * bytes keeps the canvas clean.
 *
 * Source order:
 *   1. Last.fm track.getInfo — we already hold a key and its limits are generous
 *   2. iTunes Search — no key, but ~20 req/min per IP, so misses only
 */

// Vercel's Hobby plan defaults to a 10s function limit. Ask for more headroom,
// but never rely on it — the deadline below is what actually keeps us safe.
export const config = { maxDuration: 30 };

const LFM = 'https://ws.audioscrobbler.com/2.0/';
const ITUNES = 'https://itunes.apple.com/search';
const DEADLINE_MS = 8000;      // always return before the platform kills us

// Last.fm serves this hash when it has no image at all.
const LFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

const key = (a, t) => `${a}|${t}`.toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function toDataUri(url, budgetMs = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  try {
    const r = await fetch(url, { signal: ctl.signal,
                                 headers: { 'User-Agent': 'run-card/1.0' } });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 512 || buf.length > 400_000) return null;   // junk or huge
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Last.fm tags are a folksonomy: alongside real genres you get "seen live",
   "favourites", "awesome". Only trust tags we recognise, and fold the long
   tail of subgenres into names a person would actually say out loud. */
const GENRE_MAP = {
  'classic rock':'Classic Rock','album rock':'Classic Rock','70s':'Classic Rock',
  'hard rock':'Hard Rock','arena rock':'Hard Rock','glam rock':'Hard Rock',
  'heavy metal':'Metal','metal':'Metal','thrash metal':'Metal','death metal':'Metal',
  'nu metal':'Metal','metalcore':'Metal','groove metal':'Metal','speed metal':'Metal',
  'black metal':'Metal','doom metal':'Metal','power metal':'Metal',
  'punk':'Punk','punk rock':'Punk','post-punk':'Punk','hardcore punk':'Punk',
  'rock':'Rock','rock and roll':'Rock','psychedelic rock':'Rock',
  'alternative':'Alternative','alternative rock':'Alternative','grunge':'Alternative',
  'indie':'Indie','indie rock':'Indie','indie pop':'Indie',
  'electronic':'Electronic','house':'Electronic','techno':'Electronic','edm':'Electronic',
  'dance':'Electronic','electronica':'Electronic','idm':'Electronic','ambient':'Electronic',
  'drum and bass':'Electronic','dubstep':'Electronic','trance':'Electronic',
  'hip-hop':'Hip-Hop','hip hop':'Hip-Hop','rap':'Hip-Hop','trap':'Hip-Hop',
  'pop':'Pop','synthpop':'Pop','dance-pop':'Pop','pop rock':'Pop',
  'r&b':'R&B','rnb':'R&B','soul':'Soul','funk':'Funk','disco':'Disco',
  'jazz':'Jazz','blues':'Blues','folk':'Folk','country':'Country',
  'classical':'Classical','reggae':'Reggae','soundtrack':'Soundtrack',
};

async function fromLastfmTags(artist, track, apiKey) {
  const q = (method, extra) =>
    `${LFM}?method=${method}&artist=${encodeURIComponent(artist)}${extra}`
    + `&api_key=${apiKey}&format=json&autocorrect=1`;
  // track tags are more specific; fall back to the artist's
  for (const url of [q('track.getTopTags', `&track=${encodeURIComponent(track)}`),
                     q('artist.getTopTags', '')]) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'run-card/1.0' } });
      if (!r.ok) continue;
      const j = await r.json();
      const raw = (j.toptags && j.toptags.tag) || [];
      const list = Array.isArray(raw) ? raw : [raw];
      for (const t of list) {
        const g = GENRE_MAP[String(t && t.name || '').toLowerCase().trim()];
        if (g) return g;
      }
    } catch { /* try the next one */ }
  }
  return null;
}

async function fromLastfm(artist, track, apiKey) {
  const url = `${LFM}?method=track.getInfo&artist=${encodeURIComponent(artist)}`
            + `&track=${encodeURIComponent(track)}&api_key=${apiKey}&format=json`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'run-card/1.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    const imgs = j && j.track && j.track.album && j.track.album.image;
    if (!Array.isArray(imgs)) return null;
    // prefer 'extralarge' (300px); 'mega' is often empty
    const pick = imgs.find(i => i.size === 'extralarge') ||
                 imgs.find(i => i.size === 'large');
    const u = pick && pick['#text'];
    if (!u || u.includes(LFM_PLACEHOLDER)) return null;
    return u;
  } catch { return null; }
}

async function fromItunes(artist, track) {
  const term = encodeURIComponent(`${artist} ${track}`);
  try {
    const r = await fetch(`${ITUNES}?term=${term}&entity=song&limit=1`,
                          { headers: { 'User-Agent': 'run-card/1.0' } });
    if (r.status === 429) return { rateLimited: true };
    if (!r.ok) return null;
    const j = await r.json();
    const hit = j.results && j.results[0];
    if (!hit || !hit.artworkUrl100) return null;
    // 100 → 300 is a documented, supported substitution
    return { url: hit.artworkUrl100.replace('100x100', '300x300') };
  } catch { return null; }
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await fn(items[n], n);
    }
  }));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST a { tracks: [...] } body' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const tracks = body && Array.isArray(body.tracks) ? body.tracks.slice(0, 40) : null;
  if (!tracks || !tracks.length)
    return res.status(400).json({ error: 'Body needs { tracks: [{artist, track}] }' });

  const started = Date.now();
  const left = () => DEADLINE_MS - (Date.now() - started);

  const apiKey = process.env.LASTFM_API_KEY;
  const art = {};
  const misses = [];
  let timedOut = false;

  // ── genres, alongside the artwork so it stays one round trip
  const genres = {};
  if (apiKey && body.genres !== false) {
    const gs = await pool(tracks, 6, t =>
      left() < 2500 ? null : fromLastfmTags(t.artist || '', t.track || '', apiKey));
    tracks.forEach((t, i) => { if (gs[i]) genres[key(t.artist, t.track)] = gs[i]; });
  }

  // ── pass 1: Last.fm, 6 at a time
  if (apiKey) {
    const urls = await pool(tracks, 6, t =>
      left() < 1500 ? null : fromLastfm(t.artist || '', t.track || '', apiKey));
    const withUrl = [];
    tracks.forEach((t, i) => urls[i] ? withUrl.push([t, urls[i]]) : misses.push(t));
    const uris = await pool(withUrl, 6, ([, u]) =>
      left() < 1200 ? null : toDataUri(u, Math.max(800, left() - 600)));
    withUrl.forEach(([t], i) => {
      if (uris[i]) art[key(t.artist, t.track)] = uris[i]; else misses.push(t);
    });
  } else {
    misses.push(...tracks);
  }

  // ── pass 2: iTunes for leftovers. No artificial spacing — the caller sends
  // small batches, so we stay well inside ~20 req/min without stalling here.
  let rateLimited = false;
  for (const t of misses.slice(0, 8)) {
    if (rateLimited || left() < 1800) { timedOut = left() < 1800; break; }
    const hit = await fromItunes(t.artist || '', t.track || '');
    if (hit && hit.rateLimited) { rateLimited = true; break; }
    if (hit && hit.url) {
      const uri = await toDataUri(hit.url, Math.max(800, left() - 500));
      if (uri) art[key(t.artist, t.track)] = uri;
    }
  }

  return res.status(200).json({
    art,
    genres,
    found: Object.keys(art).length,
    requested: tracks.length,
    rateLimited,
    timedOut,
    ms: Date.now() - started,
    note: apiKey ? undefined : 'LASTFM_API_KEY not set — used iTunes only',
  });
}
