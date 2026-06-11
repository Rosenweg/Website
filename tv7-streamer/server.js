/**
 * Rosenweg TV7 Streamer (LXC 250)
 *
 * Stand-alone HLS-Proxy für Init7-Tellio-Streams. Eigener LXC weil ffmpeg-
 * Transcoding (AC-3 → AAC) CPU-intensiv ist und nicht den Rosenweg-API-
 * Container belasten soll.
 *
 *   Browser  ──► nginx (Traefik /api/tv/* on isp.rosenweg4303.ch)
 *                    │
 *                    ▼
 *           tv7-streamer:3000          (LXC 250, this process)
 *                    │
 *      ┌─────────────┼──────────────┐
 *      │             │              │
 *      ▼             ▼              ▼
 *  /channels     /hls/:id         /seg
 *  Init7 m3u   spawn ffmpeg     pipe TS-segments
 *  cached      one per active   from ffmpeg
 *              session          stdout
 *
 * ffmpeg-Aufruf: Video-Stream copy, Audio AC-3 → AAC re-encode.
 *
 * Auth: simple shared-secret. rosenweg_api validiert die Session und gibt
 *       dem Browser einen kurzfristigen Bearer-Token (HMAC) den dieser
 *       Streamer hier prüft. Kein Authentik-Roundtrip pro Segment.
 */
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HMAC_SECRET = process.env.TV7_HMAC_SECRET || '';
const INIT7_PLAYLIST = 'https://api.init7.net/tvchannels.m3u?rp=true';
const INIT7_LIVE = 'https://api.tv.init7.net/api/live/?channel=';

let channelsCache = { ts: 0, data: [] };

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

function getJson(url, timeoutMs = 6000) {
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

async function getChannels() {
  if (Date.now() - channelsCache.ts < 5 * 60 * 1000 && channelsCache.data.length) {
    return channelsCache.data;
  }
  const m3u = await getJson(INIT7_PLAYLIST);
  const lines = m3u.split(/\r?\n/);
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF.*?tvg-logo="([^"]*)".*?tvg-name="([^"]*)".*?group-title="([^"]*)".*?,(.+)$/);
    if (m && lines[i + 1]) {
      const url = lines[i + 1].trim();
      const idMatch = url.match(/channel=([a-f0-9-]+)/i);
      if (idMatch) {
        channels.push({
          id: idMatch[1],
          name: m[4].trim(),
          tvg_name: m[2],
          group: m[3],
          logo: m[1],
        });
      }
    }
  }
  channelsCache = { ts: Date.now(), data: channels };
  return channels;
}

// Per-channel ffmpeg-Process — wiederverwendet, wenn mehrere Clients gleichzeitig
// denselben Channel schauen (Fanout via Tap).
const ffmpegSessions = new Map(); // channelId -> { proc, clients: Set, lastClient }

function startFfmpeg(channelId) {
  const init7Url = INIT7_LIVE + encodeURIComponent(channelId);
  log('[ffmpeg]', channelId, 'start', init7Url);
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+nobuffer+genpts+discardcorrupt+igndts',
    '-err_detect', 'ignore_err',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '4',
    '-i', init7Url,
    // Erster Video- + Audio-Stream — manche Init7-Channels haben mehrere
    // Audio-Tracks (deu/eng/...), wir nehmen Track 0.
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-f', 'mpegts',
    '-mpegts_flags', '+pat_pmt_at_frames+resend_headers',
    '-pat_period', '0.1',
    '-flush_packets', '1',
    'pipe:1',
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => log('[ffmpeg]', channelId, 'stderr:', d.toString().slice(0, 200)));
  proc.on('exit', code => {
    log('[ffmpeg]', channelId, 'exit', code);
    const sess = ffmpegSessions.get(channelId);
    if (sess) {
      for (const c of sess.clients) try { c.end(); } catch {}
      ffmpegSessions.delete(channelId);
    }
  });
  const sess = { proc, clients: new Set(), lastClient: Date.now() };
  proc.stdout.on('data', chunk => {
    for (const c of sess.clients) try { c.write(chunk); } catch {}
  });
  ffmpegSessions.set(channelId, sess);
  return sess;
}

function attachClient(channelId, res) {
  let sess = ffmpegSessions.get(channelId);
  if (!sess) sess = startFfmpeg(channelId);
  sess.clients.add(res);
  sess.lastClient = Date.now();
  res.on('close', () => {
    sess.clients.delete(res);
    log('[client] disconnect', channelId, 'remaining=' + sess.clients.size);
    if (sess.clients.size === 0) {
      setTimeout(() => {
        const cur = ffmpegSessions.get(channelId);
        if (cur && cur.clients.size === 0 && Date.now() - cur.lastClient > 8000) {
          log('[ffmpeg]', channelId, 'no clients — kill');
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
  const m = url.pathname.match(/^\/stream\/([a-f0-9-]+)$/i);
  if (m) {
    const token = url.searchParams.get('token');
    const v = verifyToken(token);
    if (!v) return sendJson(res, 401, { error: 'invalid token' });
    res.writeHead(200, {
      'Content-Type': 'video/MP2T',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Connection': 'close',
    });
    attachClient(m[1], res);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => log('tv7-streamer listening on', PORT));
