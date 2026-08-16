/* Vercel serverless function: Last.fm scrobble proxy.
 *
 * Exists because ws.audioscrobbler.com sends no Access-Control-Allow-Origin
 * header, so the browser refuses to read the response. This runs server-side,
 * where the same-origin policy doesn't apply, and keeps the API key off the
 * client entirely.
 *
 * Set LASTFM_API_KEY in Vercel → Project → Settings → Environment Variables.
 * Get a key at https://last.fm/api/account/create
 *
 *   GET /api/lastfm?user=NAME&from=UNIX&to=UNIX
 *   → { tracks: [{ at, artist, track, album, image }], count }
 */

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';

// Exported for testing: turn a Last.fm payload into our row shape.
export function toRows(json) {
  const rt = json && json.recenttracks;
  if (!rt) return [];
  let list = rt.track || [];
  if (!Array.isArray(list)) list = [list];          // single result isn't an array
  return list
    .filter(t => t && t.date && t.date.uts)         // drop the "now playing" entry
    .map(t => ({
      at: parseInt(t.date.uts, 10),                 // uts = when the track STARTED
      artist: (t.artist && (t.artist['#text'] || t.artist.name)) || '',
      track: t.name || '',
      album: (t.album && t.album['#text']) || '',
      image: Array.isArray(t.image) && t.image.length
        ? (t.image[t.image.length - 1]['#text'] || '') : '',
    }))
    .sort((a, b) => a.at - b.at);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  const { user, from, to } = req.query || {};
  const key = process.env.LASTFM_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: 'LASTFM_API_KEY is not set. Add it in Vercel → Settings → ' +
             'Environment Variables, then redeploy.',
    });
  }
  if (!user) return res.status(400).json({ error: 'Missing ?user=' });

  const f = parseInt(from, 10), t = parseInt(to, 10);
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) {
    return res.status(400).json({ error: 'from/to must be unix timestamps, to > from' });
  }
  if (t - f > 60 * 60 * 24) {
    return res.status(400).json({ error: 'Window is longer than 24 hours' });
  }

  try {
    const all = [];
    // 200 per page is the API maximum; a run needs one page, but page anyway.
    for (let page = 1; page <= 5; page++) {
      const url = `${ENDPOINT}?method=user.getrecenttracks`
        + `&user=${encodeURIComponent(user)}`
        + `&api_key=${encodeURIComponent(key)}`
        + `&from=${f}&to=${t}&limit=200&page=${page}&format=json`;

      const r = await fetch(url, { headers: { 'User-Agent': 'run-card/1.0' } });
      if (!r.ok) {
        return res.status(502).json({ error: `Last.fm returned HTTP ${r.status}` });
      }
      const json = await r.json();
      if (json.error) {
        // 6 = user not found, 10 = bad key, 29 = rate limited
        return res.status(400).json({ error: `Last.fm: ${json.message || json.error}` });
      }

      all.push(...toRows(json));

      const attr = json.recenttracks && json.recenttracks['@attr'];
      const total = attr ? parseInt(attr.totalPages, 10) : 1;
      if (!total || page >= total) break;
    }

    return res.status(200).json({ tracks: all, count: all.length });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Last.fm: ${e.message}` });
  }
}
