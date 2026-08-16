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

const LFM = 'https://ws.audioscrobbler.com/2.0/';
const ITUNES = 'https://itunes.apple.com/search';

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

  const apiKey = process.env.LASTFM_API_KEY;
  const art = {};
  const misses = [];

  // ── pass 1: Last.fm, 5 at a time
  if (apiKey) {
    const urls = await pool(tracks, 5, t => fromLastfm(t.artist || '', t.track || '', apiKey));
    const withUrl = [];
    tracks.forEach((t, i) => urls[i] ? withUrl.push([t, urls[i]]) : misses.push(t));
    const uris = await pool(withUrl, 5, ([, u]) => toDataUri(u));
    withUrl.forEach(([t], i) => { if (uris[i]) art[key(t.artist, t.track)] = uris[i]; });
    // anything that had a URL but failed to download also counts as a miss
    withUrl.forEach(([t], i) => { if (!uris[i]) misses.push(t); });
  } else {
    misses.push(...tracks);
  }

  // ── pass 2: iTunes for the leftovers, spaced out to respect ~20/min
  let rateLimited = false;
  for (const t of misses.slice(0, 14)) {
    if (rateLimited) break;
    const hit = await fromItunes(t.artist || '', t.track || '');
    if (hit && hit.rateLimited) { rateLimited = true; break; }
    if (hit && hit.url) {
      const uri = await toDataUri(hit.url);
      if (uri) art[key(t.artist, t.track)] = uri;
    }
    await sleep(250);
  }

  return res.status(200).json({
    art,
    found: Object.keys(art).length,
    requested: tracks.length,
    rateLimited,
    note: apiKey ? undefined : 'LASTFM_API_KEY not set — used iTunes only',
  });
}
