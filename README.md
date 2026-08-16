# Run Card

Drop in a run file, get a shareable card: your pace drawn as a waveform and
coloured by whatever song was playing, plus the route in 3D and your heart rate.

**Live:** _add your Vercel URL here once deployed_

---

## How it works

Everything runs in the browser. There is no server, no database, no account,
and no analytics. Your run file is read locally and never leaves your computer.

- `index.html` — the page and all the UI
- `app.js` — the engine: file parsing, grade-adjusted pace, SVG rendering
- `api/lastfm.js` — the only server-side code, purely to work around Last.fm's
  missing CORS headers

No build step, no dependencies, no framework. That is deliberate: it deploys as
a static site with one function, so it stays on the free tier and there is very
little that can break.

Your run file is read locally in the browser and never uploaded. The only thing
that touches a server is the Last.fm lookup, which sends your username and the
run's start and end times — never the file itself.

---

## Supported files

| Format | Where from | Notes |
|---|---|---|
| `.fit` | Garmin Connect → activity → gear → **Export Original** | Best. Device speed, distance, heart rate, cadence. |
| `.tcx` | Garmin Connect → gear → **Export to TCX** | Good. Has heart rate. |
| `.gpx` | Strava → activity → ⋯ → **Export GPX** | Works, but no distance field and often no heart rate. |

The FIT parser is written from scratch in `app.js` — it reads the binary format
directly, so there is no library to install or keep up to date.

---

## Adding your music

**The easy way — pull it from Last.fm.** Type your Last.fm username into the box
and hit *Fetch tracks*. The app reads the run's start and end time and asks
Last.fm what you were listening to in that window.

This needs one piece of setup, once:

1. Get a free API key at <https://last.fm/api/account/create>
2. In Vercel → your project → **Settings → Environment Variables**, add
   `LASTFM_API_KEY` with that key as the value
3. Redeploy (Deployments tab → ⋯ on the latest → Redeploy)

Why a serverless function and not a direct browser call? Last.fm's API sends no
`Access-Control-Allow-Origin` header, so browsers refuse to read the response.
`api/lastfm.js` makes the request server-side, where that rule doesn't apply.
It also keeps your API key off the client, which is the right place for it.

**The manual way — a CSV.** Drop a `songs.csv` alongside your run file:

```csv
played_at,artist,track
07:14:30,Fleetwood Mac,The Chain
07:19:01,Kendrick Lamar,HUMBLE.
```

`played_at` is when the track **started**. Use `HH:MM:SS` (assumed to be the
same day as the run) or a full ISO timestamp.

To generate this automatically: connect Spotify to Last.fm
(Last.fm → Settings → Applications → Connect next to Spotify Scrobbling), then
query `user.getRecentTracks` with `from` and `to` set to your run's start and
end times. Free API key at <https://last.fm/api/account/create>.

Last.fm is a much better source than Spotify's own API — it stores history
permanently, so there is no rolling window to poll and no cron job to run.

---

## Running it locally

No build, no npm. You do need a local web server, because browsers block
`file://` pages from loading `app.js`:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

---

## Deploying

Push to GitHub, then import the repo at [vercel.com/new](https://vercel.com/new).
Framework preset: **Other**. No build command, no output directory. Vercel serves
`index.html` from the root and redeploys on every push.

---

## Known limitations

**Out-and-back routes hide half their colours.** Where you cover the same
ground twice, the later pass draws over the earlier one. This is inherent to
plotting time-varying data on a map. The waveform doesn't have the problem
because its x-axis is time.

**Song rankings are confounded by when the song played.** If you negative-split
a run, every track from the second half looks fast regardless of what it was.
Fixing this properly means scoring each song against a rolling local baseline
rather than the whole-run average.

**Grade adjustment reduces terrain effects but doesn't remove them.** If your
biggest song effects sit exactly on your steepest hills, be suspicious.

**Vertical exaggeration can lie.** Flat routes need enormous exaggeration before
any relief is visible, and at that point you are looking at barometric sensor
noise rather than terrain. The card prints the exaggeration factor and warns you
above 60× — believe the warning.

**No music backfill.** Last.fm only records from the day you connect it. For
past runs, request your Spotify extended streaming history via Privacy Settings
→ Download your data; it takes a few days to arrive.

---

## Credit

Grade-adjusted pace uses the metabolic cost-of-gradient polynomial from
Minetti et al. (2002), *Energy cost of walking and running at extreme uphill
and downhill slopes*, Journal of Applied Physiology.
