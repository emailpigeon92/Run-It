/* Vercel serverless function: terrain basemap for the locator inset.
 *
 * GET /api/basemap?lat=&lon=&radius_m=&size=&style=outdoors
 * →   { uri: "data:image/png;base64,…", zoom, style }
 *
 * Not Google: their Platform terms forbid exporting or caching Maps content
 * for use outside their services, which is exactly what compositing a tile
 * into a downloadable PNG does. Mapbox's terms allow it, and their free tier
 * is 50,000 static images a month.
 *
 * Needs MAPBOX_TOKEN in Vercel → Settings → Environment Variables.
 */

export const config = { maxDuration: 20 };

const TILE = 512;                       // Mapbox vector styles render at 512
const EQUATOR_MPP = 78271.516964;       // metres/pixel at zoom 0, 512px tiles

const STYLES = {
  outdoors:  'mapbox/outdoors-v12',     // contours + shaded relief
  satellite: 'mapbox/satellite-v9',
  terrain:   'mapbox/outdoors-v12',
  light:     'mapbox/light-v11',
  dark:      'mapbox/dark-v11',
};

export function zoomFor(radiusM, sizePx, lat) {
  // fit a 2*radius square into sizePx
  const mpp = (2 * radiusM) / sizePx;
  const z = Math.log2(EQUATOR_MPP * Math.cos(lat * Math.PI / 180) / mpp);
  return Math.max(0, Math.min(22, z));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=2592000');

  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    return res.status(200).json({
      uri: null,
      error: 'MAPBOX_TOKEN not set — add it in Vercel → Settings → ' +
             'Environment Variables and redeploy. Free token at mapbox.com.',
    });
  }

  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  const radiusM = parseFloat(req.query.radius_m || '8046');     // 5 miles
  const size = Math.min(640, parseInt(req.query.size || '400', 10));
  const styleId = STYLES[req.query.style] || STYLES.outdoors;

  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85)
    return res.status(400).json({ uri: null, error: 'bad lat/lon' });

  const zoom = zoomFor(radiusM, size, lat);
  const url = `https://api.mapbox.com/styles/v1/${styleId}/static/`
            + `${lon.toFixed(6)},${lat.toFixed(6)},${zoom.toFixed(3)},0/`
            + `${size}x${size}@2x?access_token=${encodeURIComponent(token)}`
            + `&attribution=false&logo=false`;

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'run-card/1.0' } });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 160);
      return res.status(200).json({ uri: null, error: `Mapbox ${r.status}: ${body}` });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'image/png';
    return res.status(200).json({
      uri: `data:${type};base64,${buf.toString('base64')}`,
      zoom, style: styleId, size,
      attribution: '© Mapbox © OpenStreetMap',
    });
  } catch (e) {
    return res.status(200).json({ uri: null, error: `fetch failed: ${e.message}` });
  }
}
