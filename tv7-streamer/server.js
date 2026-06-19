/**
 * Rosenweg TV7 Streamer (LXC 250)
 *
 * Liefert alle Init7-TV-Kanaele (242) an Browser + native Player.
 *
 * Quellen pro Kanal:
 *   - Multicast (udp://@233.50.230.x:5000) — alle 242 Sender, lokal auf RK-Clients.
 *     Codecs gemischt: HEVC/H.265 (HD), H.264, mpeg2video (alte SD-Sender).
 *   - HTTP-HLS (api.tv.init7.net) — nur die ~101 Sender mit channel-id, immer H.264.
 *
 * Browser-Auslieferung (mpegts.js):
 *   - codec=hevc (HEVC-faehiger Browser): Multicast-Quelle, Video COPY (HEVC/H.264),
 *     mpeg2 -> H.264. Schlank.
 *   - sonst (H.264-Browser): H.264-Quelle wo vorhanden (HTTP-HLS, copy); Multicast-only-
 *     Sender werden nach H.264 transcodiert (HEVC->H.264 max 720p, mpeg2->H.264 SD).
 *   Audio immer AC-3/MP2 -> AAC (Browser koennen kein AC-3).
 *
 * /playlist.m3u: alle 242 als udpxy-HTTP-URLs (CT 109, cross-VLAN) fuer native Player.
 *
 * Auth: HMAC-Token (vom rosenweg_api erzeugt), pro Request geprueft.
 */
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HMAC_SECRET = process.env.TV7_HMAC_SECRET || '';
const HTTP_PLAYLIST = 'https://api.init7.net/tvchannels.m3u?rp=true'; // HTTP-HLS (H.264), liefert channel-ids
const MCAST_PLAYLIST = 'https://api.init7.net/tvchannels.m3u';        // ohne rp = Multicast (alle 242)
const INIT7_LIVE = 'https://api.tv.init7.net/api/live/?channel=';
// udpxy (CT 109 "tv-proxy", RK-Clients) joint den Multicast lokal und gibt ihn als
// HTTP-Unicast wieder raus — das routet die UDM ueber ALLE VLANs.
const UDPXY_BASE = process.env.UDPXY_BASE || 'http://100.64.9.200:4022';

let channelsCache = { ts: 0, data: [] };
let m3uCache = { ts: 0, body: '' };

function log(...a) { console.log(new Date().toISOString(), ...a); }

function verifyToken(token) {
  if (!HMAC_SECRET || !token) return false;
  try {
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return false;
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex').slice(0, 16);
    if (sig !== expected) return false;
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!obj.exp || obj.exp < Math.floor(Date.now() / 1000)) return false;
    return obj;
  } catch { return false; }
}

function getText(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// EXTINF (+ naechste Zeile = URL) aus einer m3u parsen. Attribute optional.
function parsePlaylist(m3u) {
  const lines = (m3u || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXTINF/i.test(lines[i]) || !lines[i + 1]) continue;
    const ext = lines[i];
    const url = lines[i + 1].trim();
    if (!url || url.startsWith('#')) continue;
    const logo = (ext.match(/tvg-logo="([^"]*)"/) || [])[1] || '';
    const tvg = (ext.match(/tvg-name="([^"]*)"/) || [])[1] || '';
    const group = (ext.match(/group-title="([^"]*)"/) || [])[1] || '';
    const name = ((ext.match(/,(.*)$/) || [])[1] || tvg).trim();
    out.push({ logo, tvg, group, name, url });
  }
  return out;
}

// Multicast-only-Sender (kein HTTP-channel-id): stabile, hex+bindestrich-ID aus der
// Gruppe (z.B. 233.50.230.57 -> e9-32-e6-39). Passt durch die API-id-Regex.
function mcastId(group) {
  return group.split('.').map(o => parseInt(o, 10).toString(16).padStart(2, '0')).join('-');
}

// Kanalliste aus der 242er-Multicast-Liste, gemerged mit HTTP-channel-ids (fuer
// den H.264-Pfad). Jeder Kanal: { id, mcast, httpId, h264 }.
async function getChannels() {
  if (Date.now() - channelsCache.ts < 5 * 60 * 1000 && channelsCache.data.length) {
    return channelsCache.data;
  }
  const [httpRaw, mcRaw] = await Promise.all([
    getText(HTTP_PLAYLIST),
    getText(MCAST_PLAYLIST, 8000).catch(() => ''),
  ]);
  const httpMap = {};
  for (const e of parsePlaylist(httpRaw)) {
    const id = (e.url.match(/channel=([a-f0-9-]+)/i) || [])[1];
    if (id) httpMap[e.tvg] = id;
  }
  const channels = [];
  for (const e of parsePlaylist(mcRaw)) {
    const u = e.url.match(/udp:\/\/@?([\d.]+):(\d+)/i);
    if (!u) continue;
    const mcast = u[1] + ':' + u[2];
    const httpId = httpMap[e.tvg] || null;
    const id = httpId || mcastId(u[1]);
    channels.push({
      id, name: e.name, tvg_name: e.tvg, group: e.group, logo: e.logo,
      mcast, httpId, h264: !!httpId, hevc: true,
    });
  }
  channelsCache = { ts: Date.now(), data: channels };
  return channels;
}

async function getMulticastM3U() {
  if (Date.now() - m3uCache.ts < 30 * 60 * 1000 && m3uCache.body) return m3uCache.body;
  let body = await getText(MCAST_PLAYLIST, 8000);
  // udp://@<gruppe>:<port> -> http://<udpxy>/udp/<gruppe>:<port> (cross-VLAN).
  body = body.replace(/^udp:\/\/@?([\d.]+):(\d+).*$/gm, (_m, g, p) => `${UDPXY_BASE}/udp/${g}:${p}`);
  m3uCache = { ts: Date.now(), body };
  return body;
}

// Quell-Input: Multicast fuer HEVC-Modus ODER fuer Sender ohne HTTP-Pfad; sonst HTTP-HLS.
function sourceInput(o) {
  if ((o.codec === 'hevc' || !o.httpId) && o.mcast) {
    return 'udp://@' + o.mcast + '?fifo_size=1000000&overrun_nonfatal=1&timeout=5000000';
  }
  return INIT7_LIVE + encodeURIComponent(o.httpId);
}

// Video-Codec der Quelle ermitteln (ffprobe) -> entscheidet copy vs transcode.
function probeVcodec(input) {
  return new Promise(resolve => {
    let out = '';
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', '-analyzeduration', '3000000', '-probesize', '3000000', input], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', d => out += d);
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(null); }, 6000);
    p.on('exit', () => { clearTimeout(to); resolve(out.trim().split(/\s+/)[0] || null); });
    p.on('error', () => { clearTimeout(to); resolve(null); });
  });
}

// Per-(Kanal+Codec) ffmpeg — wiederverwendet bei mehreren Clients (Fanout via Tap).
const ffmpegSessions = new Map(); // key `${id}:${codec}` -> sess
const codecCache = new Map();     // key -> Video-Codec der Quelle (gecacht)

function ffmpegArgs(sess) {
  const input = sourceInput(sess);
  const isUdp = input.startsWith('udp://');
  // Kann der Ziel-Browser das Quell-Video direkt? HEVC-Modus: hevc+h264. H.264-Modus: nur h264.
  const browserCanPlay = sess.codec === 'hevc'
    ? (sess.vcodec === 'hevc' || sess.vcodec === 'h264')
    : (sess.vcodec === 'h264');
  const copyVideo = !sess.vcodec || browserCanPlay; // unbekannt -> copy versuchen
  const vargs = copyVideo
    ? ['-c:v', 'copy', '-vsync', 'passthrough']
    // Transcode nach H.264: nur flagged-interlaced deinterlacen, HD auf max 720p
    // drosseln (HEVC-Decode ist teuer), SD bleibt SD (kein Upscale).
    : ['-vf', "yadif=deint=interlaced,scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-g', '60', '-sc_threshold', '0'];
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+nobuffer+genpts+discardcorrupt+igndts',
    '-err_detect', 'ignore_err',
    '-analyzeduration', '2000000',
    '-probesize', '1000000',
    ...(isUdp ? [] : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4']),
    '-i', input,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    ...vargs,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-af', 'aresample=async=1:first_pts=0',
    '-f', 'mpegts',
    '-mpegts_flags', '+pat_pmt_at_frames+resend_headers+initial_discontinuity',
    '-pat_period', '0.1',
    '-flush_packets', '1',
    'pipe:1',
  ];
}

// ffmpeg unter einer bestehenden Session (re)spawnen. Die Session (clients-Set)
// ueberlebt einen ffmpeg-Neustart, damit Zuschauer bei Init7-Reset / DNS-Blip
// VERBUNDEN bleiben statt mit bytes=0 rauszufliegen.
function spawnProc(sess) {
  log('[ffmpeg]', sess.key, 'start', sess.codec, 'vcodec=' + sess.vcodec);
  const proc = spawn('ffmpeg', ffmpegArgs(sess), { stdio: ['ignore', 'pipe', 'pipe'] });
  sess.proc = proc;
  sess.lastByte = Date.now();
  proc.stderr.on('data', d => log('[ffmpeg]', sess.key, 'stderr:', d.toString().slice(0, 200)));
  proc.stdout.on('data', chunk => {
    sess.lastByte = Date.now();
    if (sess.restarts) sess.restarts = 0;
    for (const c of sess.clients) try {
      c.write(chunk);
      if (c._tv7meta) c._tv7meta.bytes += chunk.length;
    } catch {}
  });
  proc.on('exit', code => {
    log('[ffmpeg]', sess.key, 'exit', code);
    if (ffmpegSessions.get(sess.key) !== sess) return;
    if (sess.clients.size === 0) { ffmpegSessions.delete(sess.key); return; }
    sess.restarts = (sess.restarts || 0) + 1;
    const delay = Math.min(4000, 300 * sess.restarts);
    log('[ffmpeg]', sess.key, 'respawn in ' + delay + 'ms (clients=' + sess.clients.size + ', #' + sess.restarts + ')');
    setTimeout(() => {
      if (ffmpegSessions.get(sess.key) === sess && sess.clients.size > 0) spawnProc(sess);
      else { for (const c of sess.clients) try { c.end(); } catch {} ffmpegSessions.delete(sess.key); }
    }, delay);
  });
}

function startFfmpeg(ch, codec, vcodec) {
  const key = ch.id + ':' + codec;
  const sess = { key, channelId: ch.id, httpId: ch.httpId, mcast: ch.mcast, codec, vcodec, proc: null, clients: new Set(), lastClient: Date.now(), lastByte: Date.now(), restarts: 0 };
  ffmpegSessions.set(key, sess);
  spawnProc(sess);
  return sess;
}

const STALE_SESSION_MS = 12000;

// Watchdog: stale (kein Output) mit Zuschauern -> kill -> respawn. Verwaiste
// Session ohne Zuschauer -> aufraeumen.
setInterval(() => {
  for (const [key, sess] of ffmpegSessions) {
    if (sess.clients.size > 0 && Date.now() - sess.lastByte > STALE_SESSION_MS) {
      log('[watchdog]', key, 'stale ' + Math.round((Date.now() - sess.lastByte) / 1000) + 's — kill+respawn (clients=' + sess.clients.size + ')');
      try { sess.proc && sess.proc.kill('SIGKILL'); } catch {}
    } else if (sess.clients.size === 0 && Date.now() - sess.lastClient > 15000) {
      log('[watchdog]', key, 'keine Zuschauer — stop');
      ffmpegSessions.delete(key);
      try { sess.proc && sess.proc.kill('SIGKILL'); } catch {}
    }
  }
}, 4000);

function attachClient(ch, codec, vcodec, res) {
  const key = ch.id + ':' + codec;
  let sess = ffmpegSessions.get(key);
  if (sess && Date.now() - sess.lastByte > STALE_SESSION_MS) {
    log('[ffmpeg]', key, 'stale (no output for ' + Math.round((Date.now() - sess.lastByte) / 1000) + 's) — restart');
    try { sess.proc.kill('SIGKILL'); } catch {}
    ffmpegSessions.delete(key);
    sess = null;
  }
  if (!sess) sess = startFfmpeg(ch, codec, vcodec);
  sess.clients.add(res);
  sess.lastClient = Date.now();
  const meta = { connectedAt: Date.now(), bytes: 0 };
  res._tv7meta = meta;
  log('[client] connect', key, 'total=' + sess.clients.size);
  res.on('close', () => {
    sess.clients.delete(res);
    const elapsed = Math.round((Date.now() - meta.connectedAt) / 100) / 10;
    log('[client] disconnect', key, 'remaining=' + sess.clients.size, 'after=' + elapsed + 's bytes=' + meta.bytes);
    if (sess.clients.size === 0) {
      setTimeout(() => {
        const cur = ffmpegSessions.get(key);
        if (cur && cur.clients.size === 0 && Date.now() - cur.lastClient > 8000) {
          log('[ffmpeg]', key, 'no clients — kill');
          try { cur.proc.kill('SIGTERM'); } catch {}
        }
      }, 10000);
    }
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, sessions: ffmpegSessions.size });
  if (url.pathname === '/channels') {
    try { return sendJson(res, 200, { channels: await getChannels() }); }
    catch (e) { return sendJson(res, 502, { error: e.message }); }
  }
  if (url.pathname === '/playlist.m3u') {
    try {
      const body = await getMulticastM3U();
      res.writeHead(200, {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
        'Content-Disposition': 'attachment; filename="rosenweg-tv-multicast.m3u"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=1800',
      });
      res.end(body);
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
    return;
  }
  const m = url.pathname.match(/^\/stream\/([a-f0-9-]+)$/i);
  if (m) {
    const token = url.searchParams.get('token');
    if (!verifyToken(token)) return sendJson(res, 401, { error: 'invalid token' });
    let ch;
    try { ch = (await getChannels()).find(c => c.id === m[1]); }
    catch (e) { return sendJson(res, 502, { error: e.message }); }
    if (!ch) return sendJson(res, 404, { error: 'unknown channel' });
    const codec = url.searchParams.get('codec') === 'hevc' ? 'hevc' : 'h264';
    // Video-Codec der Quelle (gecacht) — entscheidet copy vs transcode.
    const ckey = ch.id + ':' + codec;
    let vcodec = codecCache.get(ckey);
    if (vcodec === undefined) {
      vcodec = await probeVcodec(sourceInput({ codec, httpId: ch.httpId, mcast: ch.mcast }));
      codecCache.set(ckey, vcodec);
    }
    res.writeHead(200, {
      'Content-Type': 'video/MP2T',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Connection': 'close',
    });
    attachClient(ch, codec, vcodec, res);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => log('tv7-streamer listening on', PORT));
