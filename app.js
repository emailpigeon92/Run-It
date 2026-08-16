/* Run Card — engine.
   Pure functions, no DOM. Runs in the browser and under Node, so the same code
   that renders the page can be unit-tested against the Python original. */

// ─────────────────────────────────────────────────────────────── FIT parsing
// FIT is a binary format: a header, then a stream of "definition" messages
// describing record layouts, followed by "data" messages using those layouts.
const FIT_EPOCH = 631065600;           // 1989-12-31T00:00:00Z in unix seconds
const SEMI = 180 / Math.pow(2, 31);    // semicircles → degrees

const BASE_SIZE  = {0:1,1:1,2:1,3:2,4:2,5:4,6:4,7:1,8:4,9:8,10:1,11:2,12:4,13:1,14:8,15:8,16:8};
const BASE_INVAL = {0:0xFF,1:0x7F,2:0xFF,3:0x7FFF,4:0xFFFF,5:0x7FFFFFFF,6:0xFFFFFFFF,
                    10:0,11:0,12:0,13:0xFF};

function readBase(dv, off, base, le) {
  switch (base) {
    case 0: case 2: case 10: case 13: return dv.getUint8(off);
    case 1: return dv.getInt8(off);
    case 3: return dv.getInt16(off, le);
    case 4: case 11: return dv.getUint16(off, le);
    case 5: return dv.getInt32(off, le);
    case 6: case 12: return dv.getUint32(off, le);
    case 8: return dv.getFloat32(off, le);
    case 9: return dv.getFloat64(off, le);
    default: return null;
  }
}

function parseFIT(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 14) throw new Error('File is too small to be a FIT file');

  const headerSize = dv.getUint8(0);
  const magic = String.fromCharCode(dv.getUint8(8), dv.getUint8(9),
                                    dv.getUint8(10), dv.getUint8(11));
  if (magic !== '.FIT') throw new Error('Not a FIT file (missing .FIT signature)');

  const dataSize = dv.getUint32(4, true);
  let pos = headerSize;
  const end = Math.min(headerSize + dataSize, dv.byteLength);

  const defs = {};        // localType → {le, fields:[{num,size,base}]}
  const records = [];

  while (pos < end) {
    const h = dv.getUint8(pos++);

    if (h & 0x80) {                       // compressed timestamp header
      const local = (h >> 5) & 0x03;
      const def = defs[local];
      if (!def) break;
      pos = readData(dv, pos, def, records);
      continue;
    }

    const local = h & 0x0F;

    if (h & 0x40) {                       // definition message
      pos += 1;                           // reserved
      const le = dv.getUint8(pos++) === 0;
      const global = dv.getUint16(pos, le); pos += 2;
      const n = dv.getUint8(pos++);
      const fields = [];
      for (let i = 0; i < n; i++) {
        fields.push({ num: dv.getUint8(pos), size: dv.getUint8(pos + 1),
                      base: dv.getUint8(pos + 2) & 0x1F });
        pos += 3;
      }
      let devBytes = 0;
      if (h & 0x20) {                     // developer fields
        const dn = dv.getUint8(pos++);
        for (let i = 0; i < dn; i++) { devBytes += dv.getUint8(pos + 1); pos += 3; }
      }
      defs[local] = { le, global, fields, devBytes };
    } else {
      const def = defs[local];
      if (!def) break;
      pos = readData(dv, pos, def, records);
    }
  }

  if (!records.length) throw new Error('No GPS records found in this FIT file');
  return records;
}

function readData(dv, pos, def, out) {
  const rec = def.global === 20 ? {} : null;   // 20 = "record" message
  for (const f of def.fields) {
    if (rec && BASE_SIZE[f.base] === f.size) {
      const v = readBase(dv, pos, f.base, def.le);
      if (v !== null && v !== BASE_INVAL[f.base]) rec[f.num] = v;
    }
    pos += f.size;
  }
  pos += def.devBytes || 0;

  if (rec && rec[253] !== undefined) {
    const alt = rec[78] !== undefined ? rec[78] / 5 - 500
              : rec[2]  !== undefined ? rec[2]  / 5 - 500 : null;
    const spd = rec[73] !== undefined ? rec[73] / 1000
              : rec[6]  !== undefined ? rec[6]  / 1000 : null;
    out.push({
      t:    rec[253] + FIT_EPOCH,
      lat:  rec[0] !== undefined ? rec[0] * SEMI : null,
      lon:  rec[1] !== undefined ? rec[1] * SEMI : null,
      ele:  alt,
      hr:   rec[3] !== undefined ? rec[3] : null,
      cad:  rec[4] !== undefined ? rec[4] : null,
      dist: rec[5] !== undefined ? rec[5] / 100 : null,
      spd:  spd,
    });
  }
  return pos;
}

// ───────────────────────────────────────────────────────── GPX / TCX parsing
function parseXML(text, kind) {
  // Node has no DOMParser; fall back to regex, which is adequate for the
  // flat, predictable structure both formats use.
  const recs = [];
  const blocks = text.split(kind === 'gpx' ? /<trkpt/i : /<Trackpoint/i).slice(1);
  for (const b of blocks) {
    const g = (re) => { const m = b.match(re); return m ? m[1] : null; };
    let lat, lon;
    if (kind === 'gpx') {
      lat = g(/lat="([-0-9.]+)"/i); lon = g(/lon="([-0-9.]+)"/i);
    } else {
      lat = g(/<LatitudeDegrees>([-0-9.]+)/i); lon = g(/<LongitudeDegrees>([-0-9.]+)/i);
    }
    const time = g(/<[Tt]ime>([^<]+)/);
    if (!time) continue;
    recs.push({
      t: Date.parse(time) / 1000,
      lat: lat === null ? null : +lat,
      lon: lon === null ? null : +lon,
      ele: (() => { const v = g(/<(?:ele|AltitudeMeters)>([-0-9.]+)/i); return v && +v; })(),
      hr:  (() => { const v = g(/<(?:gpxtpx:hr|Value)>([0-9.]+)/i);      return v && +v; })(),
      cad: (() => { const v = g(/<(?:cad|Cadence)>([0-9.]+)/i);          return v && +v; })(),
      dist:(() => { const v = g(/<DistanceMeters>([0-9.]+)/i);           return v && +v; })(),
      spd: null,
    });
  }
  if (!recs.length) throw new Error('No trackpoints found');
  return recs;
}

// ─────────────────────────────────────────────────────────────── resampling
function hav(a, b, c, d) {
  const R = 6371000, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180;
  const dp = p2 - p1, dl = (d - b) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildStreams(recs, pauseGap = 12) {
  recs.sort((a, b) => a.t - b.t);
  const t0 = recs[0].t;
  recs.forEach(r => r.off = r.t - t0);

  const haveDist = recs.some(r => r.dist != null);
  const haveSpd  = recs.some(r => r.spd  != null);

  // carry sparse fields forward
  const last = { ele: 0, hr: 0, cad: 0, dist: 0, spd: 0, lat: null, lon: null };
  for (const k of ['lat', 'lon']) {
    const first = recs.find(r => r[k] != null);
    last[k] = first ? first[k] : 0;
  }
  for (const r of recs)
    for (const k of ['ele', 'hr', 'cad', 'dist', 'spd', 'lat', 'lon'])
      (r[k] == null) ? (r[k] = last[k]) : (last[k] = r[k]);

  if (!haveDist) {                       // integrate GPS, ignoring pauses
    let cum = 0;
    recs.forEach((r, i) => {
      if (i && r.off - recs[i-1].off <= pauseGap)
        cum += hav(recs[i-1].lat, recs[i-1].lon, r.lat, r.lon);
      r.dist = cum;
    });
  }

  const total = Math.floor(recs[recs.length - 1].off);
  const S = { time: [], distance: [], altitude: [], velocity_smooth: [],
              heartrate: [], cadence: [], latlng: [] };

  let j = 0;
  for (let s = 0; s <= total; s++) {
    while (j + 1 < recs.length && recs[j + 1].off <= s) j++;
    const a = recs[j], b = recs[Math.min(j + 1, recs.length - 1)];
    const span = b.off - a.off, u = span <= 0 ? 0 : (s - a.off) / span;
    const L = k => a[k] + (b[k] - a[k]) * u;
    S.time.push(s);
    S.distance.push(L('dist'));
    S.altitude.push(L('ele'));
    S.heartrate.push(L('hr'));
    S.cadence.push(L('cad'));
    S.latlng.push([L('lat'), L('lon')]);
    S.velocity_smooth.push(haveSpd ? L('spd') : 0);
  }

  if (!haveSpd) {
    const d = S.distance, raw = [];
    for (let s = 0; s < d.length; s++) {
      const lo = Math.max(0, s - 3), hi = Math.min(d.length - 1, s + 3);
      raw.push(hi > lo ? (d[hi] - d[lo]) / (hi - lo) : 0);
    }
    S.velocity_smooth = raw;
  }
  S.velocity_smooth = movingAverage(S.velocity_smooth, 9);

  return { t0, streams: S, haveSpd, haveDist };
}

// ──────────────────────────────────────────────────────────────── smoothing
function movingAverage(xs, k) {
  if (k < 2) return xs.slice();
  const out = [], half = k >> 1;
  for (let i = 0; i < xs.length; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(xs.length, i + half + 1);
    let s = 0; for (let j = lo; j < hi; j++) s += xs[j];
    out.push(s / (hi - lo));
  }
  return out;
}

function rollingMedian(xs, k) {
  const out = [], half = k >> 1;
  for (let i = 0; i < xs.length; i++) {
    const w = xs.slice(Math.max(0, i - half), Math.min(xs.length, i + half + 1)).sort((a,b)=>a-b);
    out.push(w[w.length >> 1]);
  }
  return out;
}

// ──────────────────────────────────────── grade-adjusted pace (Minetti 2002)
function minetti(g) {
  const i = Math.max(-0.45, Math.min(0.45, g));
  return 155.4*i**5 - 30.4*i**4 - 43.3*i**3 + 46.3*i**2 + 19.5*i + 3.6;
}
const FLAT = minetti(0);

function gradeAdjusted(speed, altitude, distance) {
  const elev = movingAverage(rollingMedian(altitude, 15), 21);
  const gap = [];
  for (let i = 0; i < speed.length; i++) {
    const lo = Math.max(0, i - 10), hi = Math.min(speed.length - 1, i + 10);
    const dd = distance[hi] - distance[lo];
    const g = dd > 1 ? (elev[hi] - elev[lo]) / dd : 0;
    gap.push(speed[i] * minetti(g) / FLAT);
  }
  return { gap: movingAverage(gap, 25), elev };
}

// ─────────────────────────────────────────────────────────────────── colour
function hslHex(h, s, l) {
  const f = n => {
    const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16).padStart(2, '0').toUpperCase();
  };
  return '#' + f(0) + f(8) + f(4);
}
const palette = n => Array.from({length: Math.max(1, n)}, (_, i) =>
  hslHex(8 + (i / Math.max(1, n)) * 330, 0.72, i % 2 ? 0.54 : 0.62));

// ──────────────────────────────────────────────────────────────────── songs
function parseSongsCSV(text, t0) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',').map(s => s.trim().toLowerCase());
  const iP = head.indexOf('played_at'), iA = head.indexOf('artist'), iT = head.indexOf('track');
  if (iP < 0 || iT < 0) throw new Error('songs.csv needs played_at, artist and track columns');

  const base = new Date(t0 * 1000);
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c.length < 2) continue;
    const raw = (c[iP] || '').trim();
    let when;
    if (/^\+/.test(raw)) {
      // "+12:30" = twelve and a half minutes into the run. Relative times make a
      // tracklist portable between runs, which is what you want for testing.
      const p = raw.slice(1).split(':').map(Number);
      const secs = p.length >= 3 ? p[0]*3600 + p[1]*60 + (p[2]||0) : p[0]*60 + (p[1]||0);
      when = t0 + secs;
    } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
      // Clock time, interpreted in YOUR timezone on the day of the run — which
      // is what the card header shows, so the two agree.
      const [h, m, s] = raw.split(':').map(Number);
      when = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
                      h, m, s || 0).getTime() / 1000;
    } else {
      when = Date.parse(raw) / 1000;      // full ISO timestamp, unambiguous
    }
    if (!isFinite(when)) continue;
    rows.push({ at: when, artist: (c[iA] || '').trim(), track: (c[iT] || '').trim() });
  }
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

function mapSongs(rows, t0, duration, gap) {
  const songs = [];
  rows.forEach((r, i) => {
    const a = Math.max(0, r.at - t0);
    const nxt = i + 1 < rows.length ? rows[i+1].at - t0 : a + 210;
    const b = Math.min(duration, nxt);
    if (b - a < 20) return;
    const seg = gap.slice(Math.floor(a), Math.floor(b));
    songs.push({ t0: a, t1: b, artist: r.artist, track: r.track,
                 secs: b - a,
                 gap: seg.length ? seg.reduce((x, y) => x + y, 0) / seg.length : 0 });
  });
  const pal = palette(songs.length);
  songs.forEach((s, i) => s.colour = pal[i]);
  return songs;
}

// ──────────────────────────────────────────────────────────────────── utils
const paceStr = mps => {
  if (!(mps > 0.1)) return '--:--';
  const s = 1609.34 / mps;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ──────────────────────────────────────────────────── state locator (US only)
function statesData() {
  if (typeof US_STATES !== 'undefined' && US_STATES) return US_STATES;
  if (typeof window !== 'undefined' && window.US_STATES) return window.US_STATES;
  return null;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) &&
        lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function findState(lat, lon) {
  const data = statesData();
  if (!data) return null;
  for (const name in data)
    for (const ring of data[name])
      if (pointInRing(lon, lat, ring)) return { name, rings: data[name] };
  return null;
}

// ───────────────────────────────────────────────────────────── card renderer
function buildCard(data, opts = {}) {
  const O = Object.assign({ map3d: true, rot: 20, relief: 0.32, name: null }, opts);
  const S = data.streams;
  const { gap, elev } = gradeAdjusted(S.velocity_smooth, S.altitude, S.distance);
  const duration = S.time[S.time.length - 1];
  const songs = data.songs || [];
  const hr = S.heartrate, hasHR = hr.some(h => h > 40);
  const latlng = S.latlng || [], hasMap = latlng.length > 0;

  const W = 1080;
  const BG = '#0A0A0F', INK = '#F2F2F5', DIM = '#7A7A8C', FAINT = '#1C1C26';
  const PAD = 72, PLOT_W = W - 2 * PAD, N_BARS = 168, BAR_GAP = 2.2;
  const barW = (PLOT_W - BAR_GAP * (N_BARS - 1)) / N_BARS;

  // Album covers sit above the waveform, each tied to its stretch of the run by
  // a curly brace. Only reserve the space if there is artwork to show.
  const hasArt = songs.some(s => s.art);
  const ART_SIZE = 46, BRACE_H = 14, ART_GAP = 8;
  const ART_BAND = hasArt ? ART_SIZE + ART_GAP + BRACE_H + 10 : 0;

  const MAP_TOP = 344, MAP_H = 430;
  const WAVE_HALF = hasMap ? 130 : 168;
  const WAVE_CY = (hasMap ? MAP_TOP + MAP_H + 56 + WAVE_HALF : 505) + ART_BAND;
  const STRIP_Y = WAVE_CY + WAVE_HALF + 38, STRIP_H = 16;
  const HR_TOP = STRIP_Y + STRIP_H + 50, HR_H = 80, ROW_H = 32;
  const H = (hasMap ? 1560 : 1350) + ART_BAND;

  const sorted = gap.slice().sort((a, b) => a - b);
  const gLo = sorted[Math.floor(sorted.length * 0.02)];
  const gHi = sorted[Math.floor(sorted.length * 0.98)];
  const runGap = gap.reduce((a, b) => a + b, 0) / gap.length;
  const songAt = t => songs.find(s => t >= s.t0 && t < s.t1) || null;
  const eligible = songs.filter(s => s.secs >= 60);
  const hero = eligible.length
    ? eligible.reduce((a, b) => b.gap > a.gap ? b : a)
    : (songs[0] || null);

  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">`);
  o.push(`<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#12121A"/><stop offset="55%" stop-color="${BG}"/><stop offset="100%" stop-color="#0D0D14"/></linearGradient>`);
  o.push(`<linearGradient id="hrf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FF4D6D" stop-opacity="0.55"/><stop offset="100%" stop-color="#FF4D6D" stop-opacity="0.02"/></linearGradient>`);
  o.push(`<linearGradient id="elf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5B8CB8" stop-opacity="0.42"/><stop offset="100%" stop-color="#5B8CB8" stop-opacity="0.02"/></linearGradient></defs>`);
  o.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);

  // header
  const d = new Date(data.t0 * 1000);
  const days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  let hh = d.getHours(), ap = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  const stamp = `${days[d.getDay()]} ${d.getDate()} ${mons[d.getMonth()]} ${d.getFullYear()}  ·  ${hh}:${String(d.getMinutes()).padStart(2,'0')} ${ap}`;
  o.push(`<text x="${PAD}" y="112" fill="${INK}" font-size="46" font-weight="700" letter-spacing="-1">${esc(O.name || data.name || 'Run')}</text>`);
  o.push(`<text x="${PAD}" y="150" fill="${DIM}" font-size="21" letter-spacing="2.5">${stamp}</text>`);

  let gainM = 0;
  for (let i = 1; i < elev.length; i++) gainM += Math.max(0, elev[i] - elev[i-1]);
  const stats = [
    [(S.distance[S.distance.length-1] / 1609.34).toFixed(2), 'MILES'],
    [`${Math.floor(duration/60)}:${String(Math.floor(duration%60)).padStart(2,'0')}`, 'TIME'],
    [paceStr(runGap), 'AVG GAP /MI'],
    hasHR ? [String(Math.round(hr.reduce((a,b)=>a+b,0)/hr.length)), 'AVG BPM']
          : [Math.round(gainM * 3.28084).toLocaleString(), 'FT CLIMB'],
  ];
  stats.forEach(([v, l], i) => {
    const x = Math.round(PAD + i * (PLOT_W / 4));
    o.push(`<text x="${x}" y="232" fill="${INK}" font-size="40" font-weight="600">${v}</text>`);
    o.push(`<text x="${x}" y="258" fill="${DIM}" font-size="15" letter-spacing="1.8">${l}</text>`);
  });
  // ── state locator inset, top right
  if (hasMap && opts.locator !== false) {
    const mid = latlng[Math.floor(latlng.length / 2)];
    const st = mid && findState(mid[0], mid[1]);
    if (st) {
      const BOX = 132, bx = W - PAD - BOX, by = 44;
      const pts = st.rings.flat();
      const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
      const lat0 = (Math.max(...lats) + Math.min(...lats)) / 2;
      const kx = Math.cos(lat0 * Math.PI / 180);
      const spanX = Math.max(1e-9, (Math.max(...lons) - Math.min(...lons)) * kx);
      const spanY = Math.max(1e-9, Math.max(...lats) - Math.min(...lats));
      const inner = BOX - 30;
      const sc = Math.min(inner / spanX, inner / spanY);
      const ox = bx + (BOX - spanX * sc) / 2 + Math.min(...lons) * kx * -sc;
      const oy = by + 4 + (inner - spanY * sc) / 2 + Math.max(...lats) * sc;
      const px = (lo, la) => [ox + lo * kx * sc, oy - la * sc];

      o.push(`<rect x="${bx}" y="${by}" width="${BOX}" height="${BOX}" rx="12" `
           + `fill="#101018" stroke="${FAINT}" stroke-width="1.5"/>`);
      for (const ring of st.rings) {
        const d = ring.map((p, i) => (i ? 'L' : 'M') +
          px(p[0], p[1]).map(v => v.toFixed(1)).join(',')).join(' ') + ' Z';
        o.push(`<path d="${d}" fill="#20202C" stroke="#4A4A5E" stroke-width="1.2" `
             + `stroke-linejoin="round"/>`);
      }
      const [dx, dy] = px(mid[1], mid[0]);
      o.push(`<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="6" `
           + `fill="#FF5FA2" opacity="0.28"/>`);
      o.push(`<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="3" fill="#FF5FA2"/>`);
      o.push(`<text x="${bx + BOX / 2}" y="${by + BOX - 9}" fill="${DIM}" font-size="12" `
           + `text-anchor="middle" letter-spacing="1.6">${esc(st.name.toUpperCase())}</text>`);
    }
  }

  o.push(`<line x1="${PAD}" y1="292" x2="${W-PAD}" y2="292" stroke="${FAINT}" stroke-width="1.5"/>`);

  // ── route
  let label = 'ROUTE';
  if (hasMap) {
    const lat0 = latlng.reduce((a, p) => a + p[0], 0) / latlng.length;
    const mx = latlng.map(p => (p[1] - latlng[0][1]) * 111320 * Math.cos(lat0 * Math.PI/180));
    const my = latlng.map(p => (p[0] - latlng[0][0]) * 110540);
    const ez = movingAverage(latlng.map((_, i) => elev[Math.min(i, elev.length-1)]), 61);
    const eLo = Math.min(...ez), relief = Math.max(...ez) - eLo;

    let proj, ground = null;
    if (O.map3d) {
      const ang = O.rot * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
      const c30 = Math.cos(Math.PI/6), s30 = Math.sin(Math.PI/6);
      const px = mx.map((x, i) => { const rx = x*ca - my[i]*sa, ry = x*sa + my[i]*ca; return (rx-ry)*c30; });
      const py = mx.map((x, i) => { const rx = x*ca - my[i]*sa, ry = x*sa + my[i]*ca; return (rx+ry)*s30; });
      const planSpan = Math.max(1e-9, Math.max(...py) - Math.min(...py));
      const vx = relief > 0.3 ? O.relief * planSpan / relief : 0;
      const wy = py.map((y, i) => y - (ez[i] - eLo) * vx);
      const yMin = Math.min(...wy), yMax = Math.max(...py);
      const spanX = Math.max(1e-9, Math.max(...px) - Math.min(...px));
      const spanY = Math.max(1e-9, yMax - yMin);
      const sc = Math.min(PLOT_W / spanX, MAP_H / spanY);
      const ox = PAD + (PLOT_W - spanX*sc)/2 - Math.min(...px)*sc;
      const oy = MAP_TOP + (MAP_H - spanY*sc)/2 - yMin*sc;
      proj   = px.map((x, i) => [ox + x*sc, oy + wy[i]*sc]);
      ground = px.map((x, i) => [ox + x*sc, oy + py[i]*sc]);
      label = `ROUTE  ·  ${Math.round(relief*3.28084)} FT RELIEF  ·  ${Math.round(vx)}× VERTICAL EXAGGERATION`;
    } else {
      const spanX = Math.max(1e-9, Math.max(...mx) - Math.min(...mx));
      const spanY = Math.max(1e-9, Math.max(...my) - Math.min(...my));
      const sc = Math.min(PLOT_W / spanX, MAP_H / spanY);
      const ox = PAD + (PLOT_W - spanX*sc)/2 - Math.min(...mx)*sc;
      const oy = MAP_TOP + (MAP_H - spanY*sc)/2 + Math.max(...my)*sc;
      proj = mx.map((x, i) => [ox + x*sc, oy - my[i]*sc]);
    }

    const dstr = a => a.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    if (ground) {
      o.push(`<path d="${dstr(ground)}" fill="none" stroke="#000" stroke-width="7" opacity="0.5" stroke-linejoin="round"/>`);
      o.push(`<path d="${dstr(ground)}" fill="none" stroke="#2A2A38" stroke-width="2" opacity="0.75" stroke-linejoin="round"/>`);
      const every = Math.max(1, Math.round(proj.length / 90));
      for (let i = 0; i < proj.length; i += every)
        o.push(`<line x1="${ground[i][0].toFixed(1)}" y1="${ground[i][1].toFixed(1)}" x2="${proj[i][0].toFixed(1)}" y2="${proj[i][1].toFixed(1)}" stroke="#3A3A4A" stroke-width="1" opacity="0.45"/>`);
    }
    o.push(`<path d="${dstr(proj)}" fill="none" stroke="#000" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>`);

    const step = Math.max(1, Math.floor(proj.length / 700));
    for (let k = 0; k + step < proj.length; k += step) {
      const sg = songAt(k);
      const v = gap[Math.min(k, gap.length - 1)];
      const n = Math.max(0, Math.min(1, gHi > gLo ? (v - gLo) / (gHi - gLo) : 0.5));
      o.push(`<line x1="${proj[k][0].toFixed(1)}" y1="${proj[k][1].toFixed(1)}" x2="${proj[k+step][0].toFixed(1)}" y2="${proj[k+step][1].toFixed(1)}" stroke="${sg ? sg.colour : '#3A3A48'}" stroke-width="${(3 + 4.4*n).toFixed(1)}" stroke-linecap="round"/>`);
    }
    const a0 = proj[0], a1 = proj[proj.length - 1];
    o.push(`<circle cx="${a1[0].toFixed(1)}" cy="${a1[1].toFixed(1)}" r="9" fill="${BG}" stroke="${INK}" stroke-width="3"/>`);
    o.push(`<circle cx="${a0[0].toFixed(1)}" cy="${a0[1].toFixed(1)}" r="6.5" fill="${INK}"/>`);
    o.push(`<text x="${PAD}" y="${MAP_TOP-14}" fill="${DIM}" font-size="16" letter-spacing="2.5">${label}</text>`);
  }

  // ── album covers + curly braces marking each song's stretch of the run
  if (hasArt) {
    // stack upward from the waveform: brace, gap, cover — label goes on top
    const braceTop = WAVE_CY - WAVE_HALF - 10 - BRACE_H;
    const artTop = braceTop - ART_GAP - ART_SIZE;

    o.push(`<defs><clipPath id="artclip"><rect x="0" y="0" width="${ART_SIZE}" height="${ART_SIZE}" rx="7"/></clipPath></defs>`);

    for (const sg of songs) {
      const x0 = PAD + sg.t0 / duration * PLOT_W;
      const x1 = PAD + sg.t1 / duration * PLOT_W;
      const w = x1 - x0;
      if (w < 16) continue;                    // too narrow to read anything
      const xm = (x0 + x1) / 2;

      // horizontal curly brace: two mirrored halves meeting at a downward tip
      const h = BRACE_H, k = Math.min(h, w / 4);
      o.push(`<path d="M${x0.toFixed(1)},${braceTop} `
           + `Q${x0.toFixed(1)},${braceTop + h/2} ${(xm - k).toFixed(1)},${braceTop + h/2} `
           + `Q${xm.toFixed(1)},${braceTop + h/2} ${xm.toFixed(1)},${braceTop + h} `
           + `Q${xm.toFixed(1)},${braceTop + h/2} ${(xm + k).toFixed(1)},${braceTop + h/2} `
           + `Q${x1.toFixed(1)},${braceTop + h/2} ${x1.toFixed(1)},${braceTop}" `
           + `fill="none" stroke="${sg.colour}" stroke-width="2" opacity="0.85" stroke-linecap="round"/>`);

      if (!sg.art) continue;
      const size = Math.min(ART_SIZE, w - 3);
      if (size < 18) continue;
      const ax = xm - size / 2, ay = artTop + (ART_SIZE - size) / 2;
      o.push(`<g transform="translate(${ax.toFixed(1)},${ay.toFixed(1)}) scale(${(size/ART_SIZE).toFixed(4)})">`
           + `<image x="0" y="0" width="${ART_SIZE}" height="${ART_SIZE}" `
           + `clip-path="url(#artclip)" preserveAspectRatio="xMidYMid slice" href="${sg.art}"/>`
           + `<rect x="0.5" y="0.5" width="${ART_SIZE-1}" height="${ART_SIZE-1}" rx="7" `
           + `fill="none" stroke="${sg.colour}" stroke-width="1.5" opacity="0.6"/></g>`);
    }
  }

  // ── pace waveform
  const waveLabelY = hasArt
    ? WAVE_CY - WAVE_HALF - 10 - BRACE_H - ART_GAP - ART_SIZE - 15
    : WAVE_CY - WAVE_HALF - 26;
  o.push(`<text x="${PAD}" y="${waveLabelY}" fill="${DIM}" font-size="16" letter-spacing="2.5">GRADE-ADJUSTED PACE</text>`);
  for (let b = 0; b < N_BARS; b++) {
    const lo = Math.floor(b / N_BARS * duration);
    const hi = Math.max(lo + 1, Math.floor((b + 1) / N_BARS * duration));
    let s = 0; for (let i = lo; i < hi; i++) s += gap[Math.min(i, gap.length-1)];
    const v = s / (hi - lo);
    let n = gHi > gLo ? (v - gLo) / (gHi - gLo) : 0.5;
    n = Math.max(0, Math.min(1, n));
    const h = (0.13 + 0.87 * Math.pow(n, 1.35)) * WAVE_HALF;
    const sg = songAt((b + 0.5) / N_BARS * duration);
    const x = PAD + b * (barW + BAR_GAP);
    o.push(`<rect x="${x.toFixed(2)}" y="${(WAVE_CY-h).toFixed(2)}" width="${barW.toFixed(2)}" height="${(2*h).toFixed(2)}" rx="${(barW/2).toFixed(2)}" fill="${sg ? sg.colour : '#3A3A48'}" opacity="0.92"/>`);
  }
  o.push(`<line x1="${PAD}" y1="${WAVE_CY}" x2="${W-PAD}" y2="${WAVE_CY}" stroke="${BG}" stroke-width="1.5" opacity="0.55"/>`);

  // ── song strip
  for (const s of songs) {
    const x0 = PAD + s.t0 / duration * PLOT_W, x1 = PAD + s.t1 / duration * PLOT_W;
    o.push(`<rect x="${x0.toFixed(2)}" y="${STRIP_Y}" width="${Math.max(2, x1-x0-2.5).toFixed(2)}" height="${STRIP_H}" rx="${STRIP_H/2}" fill="${s.colour}"/>`);
  }

  // ── heart rate, or elevation when there is none
  const series = hasHR ? hr : elev;
  const sLo = Math.min(...series), sHi = Math.max(...series);
  const pts = [];
  const stp = Math.max(1, Math.floor(series.length / 400));
  for (let i = 0; i < series.length; i += stp) {
    const x = PAD + S.time[i] / duration * PLOT_W;
    const n = sHi > sLo ? (series[i] - sLo) / (sHi - sLo) : 0.5;
    pts.push([x, HR_TOP + HR_H - n * HR_H]);
  }
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  o.push(`<path d="M ${PAD},${HR_TOP+HR_H} ${line} L ${W-PAD},${HR_TOP+HR_H} Z" fill="url(#${hasHR ? 'hrf' : 'elf'})"/>`);
  o.push(`<path d="${line}" fill="none" stroke="${hasHR ? '#FF4D6D' : '#7FB2DE'}" stroke-width="2.2" opacity="0.9"/>`);
  o.push(`<text x="${PAD}" y="${HR_TOP-16}" fill="${DIM}" font-size="16" letter-spacing="2.5">${hasHR ? `HEART RATE  ·  ${Math.round(sLo)}–${Math.round(sHi)} BPM` : `ELEVATION  ·  ${Math.round(sLo*3.28084)}–${Math.round(sHi*3.28084)} FT`}</text>`);

  // ── tracklist
  const LIST_Y = HR_TOP + HR_H + 76;
  o.push(`<line x1="${PAD}" y1="${LIST_Y-42}" x2="${W-PAD}" y2="${LIST_Y-42}" stroke="${FAINT}" stroke-width="1.5"/>`);
  const listed = (eligible.length ? eligible : songs).slice().sort((a,b) => b.gap - a.gap).slice(0, 8);
  const hidden = songs.length - listed.length;
  if (listed.length) {
    o.push(`<text x="${PAD}" y="${LIST_Y-52}" fill="${DIM}" font-size="16" letter-spacing="2.5">FASTEST TRACKS</text>`);
    if (hidden > 0) o.push(`<text x="${W-PAD}" y="${LIST_Y-52}" fill="${DIM}" font-size="16" text-anchor="end">+${hidden} more</text>`);
    const colW = PLOT_W / 2, rows = Math.ceil(listed.length / 2);
    listed.forEach((sg, i) => {
      const col = Math.floor(i / rows), row = i % rows;
      const x = PAD + col * colW, y = LIST_Y + row * ROW_H;
      let nm = sg.track.length > 22 ? sg.track.slice(0, 21) + '…' : sg.track;
      o.push(`<circle cx="${Math.round(x+6)}" cy="${Math.round(y-5)}" r="6" fill="${sg.colour}"/>`);
      o.push(`<text x="${Math.round(x+24)}" y="${Math.round(y)}" fill="${sg === hero ? INK : '#B9B9C6'}" font-size="19" font-weight="${sg === hero ? 700 : 400}">${esc(nm)}</text>`);
      o.push(`<text x="${Math.round(x+colW-34)}" y="${Math.round(y)}" fill="${DIM}" font-size="18" text-anchor="end">${paceStr(sg.gap)}</text>`);
    });
    const FOOT = LIST_Y + rows * ROW_H + 46;
    if (hero) {
      const delta = 1609.34/hero.gap - 1609.34/runGap;
      o.push(`<rect x="${PAD}" y="${FOOT-32}" width="4" height="52" rx="2" fill="${hero.colour}"/>`);
      o.push(`<text x="${PAD+20}" y="${FOOT-8}" fill="${DIM}" font-size="15" letter-spacing="2.5">FASTEST SONG</text>`);
      o.push(`<text x="${PAD+20}" y="${FOOT+16}" fill="${INK}" font-size="23" font-weight="600">${esc(hero.track)} <tspan fill="${DIM}" font-weight="400">— ${esc(hero.artist)}</tspan></text>`);
      o.push(`<text x="${W-PAD}" y="${FOOT+10}" fill="${hero.colour}" font-size="34" font-weight="700" text-anchor="end">${Math.abs(delta).toFixed(0)}s/mi</text>`);
      o.push(`<text x="${W-PAD}" y="${FOOT+32}" fill="${DIM}" font-size="15" text-anchor="end" letter-spacing="1.5">${delta < 0 ? 'FASTER' : 'SLOWER'} THAN AVG</text>`);
    }
  } else {
    o.push(`<text x="${PAD}" y="${LIST_Y}" fill="${DIM}" font-size="19">No tracklist — drop a songs.csv to colour this run by music.</text>`);
  }

  o.push('</svg>');
  return { svg: o.join('\n'), stats: {
    miles: S.distance[S.distance.length-1] / 1609.34, duration,
    gap: runGap, hasHR, avgHR: hasHR ? hr.reduce((a,b)=>a+b,0)/hr.length : null,
    songs: songs.length, hero,
  }};
}

// ──────────────────────────────────────────────────────────────── zip support
// Garmin Connect's "Export Original" hands you a .zip with the .fit inside.
// Rather than make people unzip by hand every time, read the archive directly.
// Uses the browser's built-in DecompressionStream — no library needed.
async function extractFromZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // End of Central Directory: scan backwards for 0x06054b50
  let eocd = -1;
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That .zip looks damaged — try downloading it again');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);          // central directory offset

  const wanted = [];
  for (let i = 0; i < count && p + 46 <= dv.byteLength; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method  = dv.getUint16(p + 10, true);
    const compLen = dv.getUint32(p + 20, true);
    const fnLen   = dv.getUint16(p + 28, true);
    const exLen   = dv.getUint16(p + 30, true);
    const cmLen   = dv.getUint16(p + 32, true);
    const localAt = dv.getUint32(p + 42, true);
    const name    = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fnLen));
    if (/\.(fit|tcx|gpx)$/i.test(name) && !name.startsWith('__MACOSX'))
      wanted.push({ name, method, compLen, localAt });
    p += 46 + fnLen + exLen + cmLen;
  }

  if (!wanted.length)
    throw new Error('No .fit, .tcx or .gpx file inside that zip');

  const e = wanted[0];
  // local header tells us where the data actually starts
  if (dv.getUint32(e.localAt, true) !== 0x04034b50)
    throw new Error('That .zip looks damaged — try downloading it again');
  const lfn = dv.getUint16(e.localAt + 26, true);
  const lex = dv.getUint16(e.localAt + 28, true);
  const start = e.localAt + 30 + lfn + lex;
  const raw = u8.subarray(start, start + e.compLen);

  if (e.method === 0) return { name: e.name, data: raw.slice().buffer };
  if (e.method !== 8)
    throw new Error(`Unsupported compression in that zip (method ${e.method})`);
  if (typeof DecompressionStream === 'undefined')
    throw new Error('This browser cannot read zips — unzip it yourself and drop the .fit');

  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([raw]).stream().pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return { name: e.name, data: out };
}

// ─────────────────────────────────────────────────────────────── entry point
/* Identify a file by its contents, never by its name.
   macOS renames duplicate downloads to "Run.fit 2", Windows to "Run (1).fit",
   and plenty of exports arrive with no extension at all. The bytes don't lie. */
function sniff(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.byteLength >= 4 && dv.getUint32(0, false) === 0x504B0304) return 'zip';
  if (dv.byteLength >= 12 &&
      String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === '.FIT') return 'fit';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(0, 4096));
  if (/<gpx[\s>]/i.test(head)) return 'gpx';
  if (/<TrainingCenterDatabase|<Trackpoint/i.test(head)) return 'tcx';
  return null;
}

function cleanName(name) {
  return name
    .replace(/\.(fit|tcx|gpx|zip)\b.*$/i, '')   // extension and any " 8" after it
    .replace(/[\s_-]*\(?\d+\)?$/, '')           // trailing "(1)" or " 2"
    .replace(/[_-]+/g, ' ')
    .trim() || 'Run';
}

function loadActivity(name, bufOrText) {
  // accept a string for convenience, but sniffing needs bytes
  const buf = typeof bufOrText === 'string'
    ? new TextEncoder().encode(bufOrText).buffer : bufOrText;

  const kind = sniff(buf);
  if (kind === 'zip')
    throw new Error('That is a .zip — the site should have unpacked it. Try again, '
                  + 'or unzip it yourself and drop the file inside.');
  if (!kind)
    throw new Error("Couldn't recognise that file. It should be a .fit, .tcx or .gpx "
                  + 'export from Garmin or Strava.');

  const recs = kind === 'fit'
    ? parseFIT(buf)
    : parseXML(new TextDecoder().decode(new Uint8Array(buf)), kind);

  const built = buildStreams(recs);
  return { name: cleanName(name), t0: built.t0, streams: built.streams, songs: [] };
}

const API = { loadActivity, extractFromZip, sniff, cleanName, findState, parseFIT, parseXML, buildStreams, buildCard,
              parseSongsCSV, mapSongs, gradeAdjusted, paceStr, palette };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.RunCard = API;
