'use strict';
/**
 * ShortFactory — server.js
 * ========================
 * Génère des Shorts 9:16 depuis n'importe quelle vidéo YouTube
 * et publie directement sur TikTok (Content Posting API v2).
 *
 * Prérequis système : ffmpeg, yt-dlp  (installés via Dockerfile)
 * npm install express cors multer fluent-ffmpeg axios form-data ws uuid dotenv
 */

require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
const path           = require('path');
const fs             = require('fs');
const { exec, spawn } = require('child_process');
const { promisify }  = require('util');
const execAsync      = promisify(exec);
const axios          = require('axios');
const FormData       = require('form-data');
const { v4: uuidv4 } = require('uuid');
const http           = require('http');
const WebSocket      = require('ws');
const QRCode         = require('qrcode');

// ─── App & serveur ────────────────────────────────────────────────────────────
const app = express();
if (String(process.env.TRUST_PROXY || '').toLowerCase() === '1') app.set('trust proxy', 1);
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT      = process.env.PORT || 3000;
const WORK_DIR  = path.join(__dirname, 'tmp');
const OUT_DIR   = path.join(__dirname, 'output');
const DATA_DIR  = path.join(__dirname, 'data');
const LEGAL_DIR  = path.join(__dirname, 'public', 'legal');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = path.join(__dirname, 'shortfactory.html');
const TOKENS_PATH = process.env.OAUTH_TOKENS_FILE || path.join(DATA_DIR, 'oauth-tokens.json');

function readLegalPage(name) {
  const p = path.join(LEGAL_DIR, name);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    console.error(`[legal] fichier manquant ou illisible: ${p} — ${e.message}`);
    return null;
  }
}

[WORK_DIR, OUT_DIR, DATA_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

const LEGAL_PAGES = {
  terms:   readLegalPage('terms.html'),
  privacy: readLegalPage('privacy.html'),
};

// ─── Configuration génération ─────────────────────────────────────────────────
const SHORT_SEGMENT_SEC = Math.max(5, Math.min(600, Number(process.env.SHORT_SEGMENT_SEC) || 60));
const GEN_BUDGET_MS     = Math.max(30000, Math.min(7200000, Number(process.env.GEN_BUDGET_MS) || 600000));
const GEN_MAX_SHORTS    = Math.max(1, Math.min(200, Number(process.env.GEN_MAX_SHORTS) || 100));
const OUT_W = 1080;
const OUT_H = 1920;
const FIT_PAD        = String(process.env.SHORTS_FRAME_FIT || 'pad').toLowerCase() !== 'crop';
const ENCODE_PRESET  = process.env.ENCODE_PRESET || 'ultrafast';
const ENCODE_CRF     = String(process.env.ENCODE_CRF || '26');
const ENCODE_PARALLEL = Math.max(1, Math.min(4, Number(process.env.ENCODE_PARALLEL) || 2));
const SUBTITLE_BURN  = ['1','true','yes','on'].includes(String(process.env.SUBTITLE_BURN ?? '0').trim().toLowerCase());
const USE_H265       = String(process.env.SHORTS_CODEC || 'h264').toLowerCase() === 'h265';

const YTDLP_FORMAT = process.env.YTDLP_FORMAT_OVERRIDE ||
  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/' +
  'best[height<=480][ext=mp4]/best[height<=480]/' +
  'bestvideo[height<=720]+bestaudio/best[height<=720]/best';

// ─── URLs légales ─────────────────────────────────────────────────────────────
function publicBase() {
  return (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
}
function legalUrls(req) {
  const base = publicBase() || (() => {
    const host  = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
    const proto = (req.get('x-forwarded-proto') || '').split(',')[0].trim() || req.protocol || 'http';
    return `${proto}://${host}`;
  })();
  return { terms: `${base}/legal/terms`, privacy: `${base}/legal/privacy`, home: `${base}/` };
}

// ─── OAuth config ─────────────────────────────────────────────────────────────
const TIKTOK_CB = '/auth/tiktok/callback';
const OAUTH = {
  tiktok: {
    clientKey:    process.env.TIKTOK_CLIENT_KEY    || '',
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
    redirectUri:  process.env.TIKTOK_REDIRECT_URI  || `http://localhost:${PORT}${TIKTOK_CB}`,
    scope: (process.env.TIKTOK_SCOPE || 'user.info.basic,video.upload,video.publish')
      .split(/[\s,]+/).filter(Boolean).join(','),
    authUrl:  'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
  },
};

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Token store (persisté sur disque) ───────────────────────────────────────
const tokenStore = {};
function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) return;
    Object.assign(tokenStore, JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')));
    console.log(`[oauth] ${Object.keys(tokenStore).length} compte(s) chargé(s)`);
  } catch (e) { console.warn('[oauth] lecture:', e.message); }
}
function saveTokens() {
  try {
    fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenStore));
  } catch (e) { console.warn('[oauth] écriture:', e.message); }
}
loadTokens();

// ─── WebSocket broadcast ──────────────────────────────────────────────────────
const wsClients = new Set();
wss.on('connection', ws => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});
function broadcast(jobId, event, data = {}) {
  const msg = JSON.stringify({ jobId, event, ...data });
  wsClients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
}

// ─── CSRF states TikTok ───────────────────────────────────────────────────────
const oauthStates = new Map();
function storeState(s) {
  oauthStates.set(s, Date.now() + 600000);
  for (const [k, t] of oauthStates) if (t < Date.now()) oauthStates.delete(k);
}
function consumeState(s) {
  if (!s) return false;
  const exp = oauthStates.get(String(s));
  oauthStates.delete(String(s));
  return typeof exp === 'number' && exp > Date.now();
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES LÉGALES (TikTok en a besoin avant tout — HTML préchargé, pas de sendFile)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/legal/terms', (req, res) => {
  if (!LEGAL_PAGES.terms) return res.status(404).type('txt').send('Not Found');
  res.status(200).type('html').send(LEGAL_PAGES.terms);
});
app.get('/legal/privacy', (req, res) => {
  if (!LEGAL_PAGES.privacy) return res.status(404).type('txt').send('Not Found');
  res.status(200).type('html').send(LEGAL_PAGES.privacy);
});

// Santé Render (health check léger — pas de DB)
app.get('/health', (req, res) => res.status(200).type('txt').send('ok'));

// ═════════════════════════════════════════════════════════════════════════════
//  API — Infos setup TikTok (utile pour debug)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/tiktok/setup', (req, res) => {
  const lu   = legalUrls(req);
  const base = publicBase();
  res.json({
    redirectUri: OAUTH.tiktok.redirectUri,
    scopes: OAUTH.tiktok.scope.split(','),
    tiktokDeveloperPortal: {
      '1_Terms_of_Service_URL': base ? `${base}/legal/terms`   : lu.terms,
      '2_Privacy_Policy_URL':   base ? `${base}/legal/privacy` : lu.privacy,
      '3_Redirect_URI':         OAUTH.tiktok.redirectUri,
      '4_Webhook_Callback_URL': base ? `${base}/api/tiktok/webhook` : `http://localhost:${PORT}/api/tiktok/webhook`,
      '5_Website_URL':          base ? base : `http://localhost:${PORT}`,
      '6_Scopes':               'user.info.basic + video.upload + video.publish',
      '7_Products':             'Login Kit + Content Posting API',
    },
    ok: !!(OAUTH.tiktok.clientKey && OAUTH.tiktok.clientSecret),
  });
});

app.get('/api/oauth/status', (req, res) => {
  const hasKeys = !!(OAUTH.tiktok.clientKey && OAUTH.tiktok.clientSecret);
  const manualUi = ['1', 'true', 'yes', 'on', 'manual'].includes(
    String(process.env.SHORTFACTORY_MANUAL_TIKTOK ?? '').trim().toLowerCase()
  );
  res.json({
    tiktok: {
      ready: hasKeys,
      /** false si SHORTFACTORY_MANUAL_TIKTOK=1 : UI MP4 seulement, même avec clés en .env */
      publishViaApi: hasKeys && !manualUi,
      redirectUri: OAUTH.tiktok.redirectUri,
    },
  });
});

app.get('/api/oauth/accounts', (req, res) => {
  res.json({ accounts: Object.entries(tokenStore).map(([id, a]) => ({ id, network: a.network, username: a.username || '', avatar: a.avatar || '' })) });
});

/** QR code : uniquement pour nos MP4 /output/… (évite abus open-proxy) */
function qrTargetUrlAllowed(raw, req) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (!/^\/output\/[0-9a-f-]+_short_\d+\.mp4$/i.test(u.pathname)) return false;
    const want = u.hostname.toLowerCase();
    const hdr = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim().toLowerCase();
    const reqHost = hdr.replace(/:\d+$/, '');
    if (want === reqHost) return true;
    if ((want === 'localhost' || want === '127.0.0.1') && (reqHost === 'localhost' || reqHost === '127.0.0.1')) return true;
    const base = publicBase();
    if (base) {
      try {
        if (new URL(base).hostname.toLowerCase() === want) return true;
      } catch { /* ignore */ }
    }
    return false;
  } catch {
    return false;
  }
}

app.get('/api/qr', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!raw || !qrTargetUrlAllowed(raw, req)) {
    return res.status(400).type('txt').send('URL invalide');
  }
  try {
    const buf = await QRCode.toBuffer(raw, { type: 'png', width: 280, margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('image/png').send(buf);
  } catch (e) {
    console.warn('[qr]', e.message);
    res.status(500).type('txt').send('QR error');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  OAUTH — TikTok Login Kit
// ═════════════════════════════════════════════════════════════════════════════
app.get('/auth/tiktok', (req, res) => {
  if (!OAUTH.tiktok.clientKey || !OAUTH.tiktok.clientSecret) {
    return res.status(503).send(`<html><body style="font-family:sans-serif;padding:24px">
      <h2>⚠️ Clés TikTok manquantes</h2>
      <p>Ajoute <code>TIKTOK_CLIENT_KEY</code> et <code>TIKTOK_CLIENT_SECRET</code> dans <code>.env</code></p>
      <p>Redirect URI à enregistrer sur developers.tiktok.com : <code>${esc(OAUTH.tiktok.redirectUri)}</code></p>
    </body></html>`);
  }
  const state = uuidv4();
  storeState(state);
  const params = new URLSearchParams({
    client_key: OAUTH.tiktok.clientKey,
    response_type: 'code',
    scope: OAUTH.tiktok.scope,
    redirect_uri: OAUTH.tiktok.redirectUri,
    state,
  });
  res.redirect(`${OAUTH.tiktok.authUrl}?${params}`);
});

app.get(TIKTOK_CB, async (req, res) => {
  const { code, state, error, error_description: errDesc } = req.query;

  if (error) {
    return res.status(400).send(`<html><body style="font-family:sans-serif;padding:24px">
      <p><strong>TikTok a refusé la connexion :</strong> ${esc(errDesc || error)}</p>
      <p>Redirect URI attendue : <code>${esc(OAUTH.tiktok.redirectUri)}</code></p>
      <p>Ferme cette fenêtre et réessaie.</p>
    </body></html>`);
  }
  if (!code) return res.status(400).send('<html><body>Pas de code. Ferme et réessaie.</body></html>');
  if (!consumeState(String(state))) {
    return res.status(400).send('<html><body>Session OAuth expirée. Ferme et relance la connexion TikTok.</body></html>');
  }

  try {
    const { data } = await axios.post(OAUTH.tiktok.tokenUrl,
      new URLSearchParams({
        client_key:    OAUTH.tiktok.clientKey,
        client_secret: OAUTH.tiktok.clientSecret,
        code:          String(code),
        grant_type:    'authorization_code',
        redirect_uri:  OAUTH.tiktok.redirectUri,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (data.error) throw new Error(data.error_description || data.error);
    if (!data.access_token) throw new Error('Pas de token reçu');

    const { data: uBody } = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
      params:  { fields: 'open_id,display_name,avatar_url' },
      headers: { Authorization: `Bearer ${data.access_token}` },
      validateStatus: () => true,
    });
    const u = uBody?.data?.user;
    if (!u?.open_id) throw new Error('user.info invalide (scope user.info.basic activé ?)');

    let accId = Object.entries(tokenStore).find(([, a]) => a.network === 'tiktok' && a.userId === u.open_id)?.[0] || uuidv4();
    const expiresIn = Number(data.expires_in);
    tokenStore[accId] = {
      network:        'tiktok',
      accessToken:    data.access_token,
      refreshToken:   data.refresh_token || '',
      userId:         u.open_id,
      username:       u.display_name || 'Compte TikTok',
      avatar:         u.avatar_url   || '',
      tokenExpiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    };
    saveTokens();

    const payload = JSON.stringify({ network: 'tiktok', accId, username: tokenStore[accId].username, avatar: tokenStore[accId].avatar });
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#0b0b14;color:#eee;font-family:sans-serif">
<script>
(function(){
  var msg = ${payload};
  try { if(window.opener && !window.opener.closed) window.opener.postMessage(msg,'*'); } catch(e){}
  try { new BroadcastChannel('shortfactory-oauth').postMessage(msg); } catch(e){}
})();
<\/script>
<p style="text-align:center;padding:40px;font-size:15px">
  <strong style="color:#00e676">✓ Connexion TikTok réussie.</strong><br><br>
  Ferme cette fenêtre et reviens sur ShortFactory.
</p>
<script>setTimeout(function(){try{window.close();}catch(e){}},800);<\/script>
</body></html>`);
  } catch (e) {
    console.error('[tiktok oauth]', e.message);
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:24px">
      <p><strong>Erreur OAuth TikTok :</strong> ${esc(e.message)}</p>
      <p>Redirect URI : <code>${esc(OAUTH.tiktok.redirectUri)}</code></p>
    </body></html>`);
  }
});

// Webhook TikTok (obligatoire dans le portail pour passer la validation)
app.post('/api/tiktok/webhook', (req, res) => {
  console.log('[tiktok webhook]', JSON.stringify(req.body || {}).slice(0, 200));
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PAGE D'ACCUEIL (avant express.static pour éviter tout conflit avec « / »)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(INDEX_HTML));

// ═════════════════════════════════════════════════════════════════════════════
//  FICHIERS STATIQUES (/legal/*.html aussi servi ici en secours si extension .html)
// ═════════════════════════════════════════════════════════════════════════════
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h', index: false }));

// Streaming vidéo avec Range (lecture <video> fiable dans le navigateur)
app.get('/output/:file', (req, res, next) => {
  const base = path.basename(req.params.file || '');
  if (!/^[0-9a-f-]+_short_\d+\.mp4$/i.test(base)) return next();
  const abs = path.resolve(OUT_DIR, base);
  if (path.relative(OUT_DIR, abs).startsWith('..')) return next();
  fs.access(abs, fs.constants.R_OK, err => {
    if (err) return next();
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(abs, e => e && next(e));
  });
});
app.use('/output', express.static(OUT_DIR));

// ═════════════════════════════════════════════════════════════════════════════
//  1. METADATA YOUTUBE
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/video/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url requis' });
  try {
    const { stdout } = await execAsync(`yt-dlp --dump-json --no-playlist "${url}"`, { timeout: 30000 });
    const info = JSON.parse(stdout);
    const totalShorts = Math.min(GEN_MAX_SHORTS, Math.max(1, Math.ceil(info.duration / SHORT_SEGMENT_SEC)));
    res.json({
      id: info.id, title: info.title, duration: info.duration,
      thumbnail: info.thumbnail, uploader: info.uploader,
      segmentSec: SHORT_SEGMENT_SEC, shortCount: totalShorts,
      genBudgetSec: Math.round(GEN_BUDGET_MS / 1000),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. GÉNÉRATION DES SHORTS (streaming progressif)
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/generate', async (req, res) => {
  const { url, networks, duration: srcDuration, publishAccounts, videoTitle, subtitleBurn } = req.body;
  if (!url || !networks?.length) return res.status(400).json({ error: 'url + networks requis' });
  const jobId = uuidv4();
  res.json({ jobId, message: 'Génération démarrée' });
  runGenJob(jobId, url, networks, Number(srcDuration) || 0, {
    publishAccounts: Array.isArray(publishAccounts) ? publishAccounts : [],
    videoTitle: String(videoTitle || '').trim(),
    subtitleBurn: typeof subtitleBurn === 'boolean' ? subtitleBurn : SUBTITLE_BURN,
  });
});

async function runGenJob(jobId, url, networks, srcDuration, opts) {
  const budgetTimer = setTimeout(() => {
    broadcast(jobId, 'error', { message: `Budget temps dépassé (${GEN_BUDGET_MS / 1000}s)` });
  }, GEN_BUDGET_MS);

  const allowAutoPub = ['1','true','yes','on'].includes(
    String(process.env.CAPCUT_PUBLISH_AFTER_GENERATE ?? '1').trim().toLowerCase()
  );

  const allShorts = [];

  const onBatch = async (done) => {
    for (const s of done) {
      const sOut = {
        ...s,
        title: buildTitle(opts.videoTitle, s.id),
      };
      allShorts.push(sOut);
      broadcast(jobId, 'short_ready', { short: sOut });

      if (allowAutoPub && opts.publishAccounts.length > 0) {
        runPublishJob(uuidv4(), opts.publishAccounts, [sOut]).catch(e =>
          broadcast(jobId, 'publish_error', { shortId: s.id, error: e.message })
        );
      }
    }
  };

  try {
    const { shorts, totalSec, shortCount } = await runGeneration(jobId, url, srcDuration, onBatch, {
      subtitleBurn: opts.subtitleBurn,
    });
    clearTimeout(budgetTimer);
    broadcast(jobId, 'done', { shorts: allShorts, totalDuration: totalSec, shortCount });
  } catch (err) {
    clearTimeout(budgetTimer);
    console.error('[generate]', err.message);
    broadcast(jobId, 'error', { message: err.message || String(err) });
  }
}

async function runGeneration(jobId, url, srcDuration, onBatch, genOpts = {}) {
  const burn = genOpts.subtitleBurn !== undefined && genOpts.subtitleBurn !== null
    ? !!genOpts.subtitleBurn
    : SUBTITLE_BURN;
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const rawVideo = path.join(jobDir, 'source.mp4');

  let downloadAll = false;
  let sectionEndSec = 7200;
  if (srcDuration > 1) {
    const needed = Math.ceil(srcDuration) + 30;
    if (needed <= 7200) sectionEndSec = needed;
    else downloadAll = true;
  }

  const ytBase = [
    '-f', YTDLP_FORMAT,
    '--merge-output-format', 'mp4',
    '-o', rawVideo,
    '--no-playlist', '--no-mtime',
    '--socket-timeout', '30',
    '--retries', '3',
    '--concurrent-fragments', '4',
  ];

  function mm(s) { const sec = Math.floor(s); return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`; }

  broadcast(jobId, 'progress', { step: 'download', pct: 0, msg: downloadAll
    ? `Téléchargement vidéo complète (~${Math.ceil(srcDuration)}s)…`
    : `Téléchargement 480p (0–${mm(sectionEndSec)})…` });

  const dlArgs = downloadAll
    ? [...ytBase, url]
    : [...ytBase, '--download-sections', `*0:00-${mm(sectionEndSec)}`, url];

  await new Promise((resolve, reject) => {
    const dl = spawn('yt-dlp', dlArgs, { stdio: ['ignore','pipe','pipe'], windowsHide: true });
    dl.stderr.on('data', d => {
      const m = d.toString().match(/(\d+\.\d+)%/);
      if (m) broadcast(jobId, 'progress', { step: 'download', pct: parseFloat(m[1]), msg: `Téléchargement ${parseFloat(m[1]).toFixed(0)}%` });
    });
    dl.on('close', code => {
      if (code === 0) return resolve();
      const dl2 = spawn('yt-dlp', [...ytBase, url], { stdio: ['ignore','pipe','pipe'], windowsHide: true });
      dl2.on('close', c2 => c2 === 0 ? resolve() : reject(new Error(`yt-dlp exit ${c2}`)));
    });
  });
  broadcast(jobId, 'progress', { step: 'download', pct: 100, msg: 'Téléchargement terminé ✓' });

  const { stdout: probeOut } = await execAsync(`ffprobe -v quiet -print_format json -show_format "${rawVideo}"`);
  const totalSec = parseFloat(JSON.parse(probeOut).format.duration);
  if (!Number.isFinite(totalSec) || totalSec <= 0) throw new Error('Durée vidéo introuvable');

  const shortCount = Math.min(GEN_MAX_SHORTS, Math.max(1, Math.ceil(totalSec / SHORT_SEGMENT_SEC)));
  const words = burn ? buildDecorWords(totalSec) : [];
  const codecLbl = USE_H265 ? 'H.265' : 'H.264';
  broadcast(jobId, 'progress', { step: 'cut', pct: 0, msg: `${shortCount} short(s) × ${SHORT_SEGMENT_SEC}s · ${codecLbl} ${ENCODE_PRESET}${burn ? ' · mots CapCut' : ''}` });

  const shorts = [];
  for (let b = 0; b < shortCount; b += ENCODE_PARALLEL) {
    const slice = [];
    for (let k = 0; k < ENCODE_PARALLEL && b + k < shortCount; k++) {
      slice.push(encodeShort(jobId, jobDir, rawVideo, words, totalSec, b + k, burn));
    }
    const done = await Promise.all(slice);
    done.sort((a, z) => a.id - z.id);
    shorts.push(...done);
    if (onBatch) await onBatch(done);
    broadcast(jobId, 'progress', { step: 'cut', pct: Math.round((shorts.length / shortCount) * 100), msg: `${shorts.length}/${shortCount} short(s) ✓` });
  }

  try { fs.unlinkSync(rawVideo); } catch {}
  return { shorts, totalSec, shortCount };
}

// ─── Encodage d'un short ──────────────────────────────────────────────────────
async function encodeShort(jobId, jobDir, rawVideo, words, totalSec, i, burn) {
  const start   = i * SHORT_SEGMENT_SEC;
  const end     = Math.min(start + SHORT_SEGMENT_SEC, totalSec);
  const dur     = Math.max(0.1, end - start);
  const outFile = path.join(OUT_DIR, `${jobId}_short_${i + 1}.mp4`);

  const assName = `sub_${i}.ass`;
  const assFile = path.join(jobDir, assName);
  const subWords = burn
    ? words.filter(w => w.end > start && w.start < end)
      .map(w => ({ word: w.word, start: Math.max(w.start, start), end: Math.min(w.end, end) }))
      .filter(w => w.word && w.end > w.start)
    : [];
  if (burn) writeASS(subWords, start, assFile, OUT_W, OUT_H);

  const lanczos = ':flags=lanczos';
  const vfBase = FIT_PAD
    ? `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease${lanczos},pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
    : `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase${lanczos},crop=${OUT_W}:${OUT_H},setsar=1`;
  const vfSub      = burn ? `${vfBase},subtitles=${assName}` : vfBase;
  const vfFallback = `scale=${OUT_W}:${OUT_H}:flags=bilinear`;

  const vArgs = USE_H265
    ? ['-c:v', 'libx265', '-preset', ENCODE_PRESET, '-crf', ENCODE_CRF]
    : ['-c:v', 'libx264', '-preset', ENCODE_PRESET, '-crf', ENCODE_CRF, '-pix_fmt', 'yuv420p', '-tune', 'zerolatency'];

  const inputRel = path.basename(rawVideo);

  function mkArgs(vf, seekBefore) {
    const head = ['-hide_banner', '-nostdin', '-loglevel', 'warning'];
    const tail  = ['-vf', vf, ...vArgs, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outFile];
    return seekBefore
      ? [...head, '-ss', String(start), '-t', String(dur), '-i', inputRel, ...tail]
      : [...head, '-i', inputRel, '-ss', String(start), '-t', String(dur), ...tail];
  }

  function runFF(vf, seekBefore) {
    return new Promise((resolve, reject) => {
      const errBuf = [];
      const ff = spawn('ffmpeg', mkArgs(vf, seekBefore), { cwd: jobDir, stdio: ['ignore','ignore','pipe'], windowsHide: true });
      ff.stderr.on('data', c => errBuf.push(c));
      ff.on('error', reject);
      ff.on('close', code => {
        if (code === 0) return resolve();
        const msg = Buffer.concat(errBuf).toString().trim().split(/\r?\n/).slice(-8).join(' | ');
        reject(new Error(`FFmpeg short ${i+1} (${code}) ${msg}`));
      });
    });
  }

  const attempts = burn
    ? [() => runFF(vfSub, true), () => runFF(vfBase, true), () => runFF(vfBase, false), () => runFF(vfFallback, false)]
    : [() => runFF(vfBase, true), () => runFF(vfBase, false), () => runFF(vfFallback, false)];

  let lastErr;
  for (const fn of attempts) {
    try { await fn(); lastErr = null; break; }
    catch (e) { lastErr = e; console.warn(`[ffmpeg short ${i+1}]`, e.message.slice(0, 120)); }
  }
  if (burn) try { fs.unlinkSync(assFile); } catch {}
  if (lastErr) throw lastErr;

  return { id: i + 1, start, end, duration: end - start, file: `/output/${jobId}_short_${i + 1}.mp4`, localPath: outFile, width: OUT_W, height: OUT_H };
}

// ─── Titre CapCut ─────────────────────────────────────────────────────────────
function buildTitle(videoTitle, shortId) {
  const base = videoTitle ? String(videoTitle).trim().slice(0, 1800) : '';
  return (base ? `${base} · #${shortId} #shorts #fyp` : `Clip #${shortId} #shorts #fyp`).slice(0, 2200);
}

// ─── Mots décoratifs ASS ──────────────────────────────────────────────────────
function buildDecorWords(totalDuration) {
  const hooks = [
    'SWIPE','REGARDE','LIKE','FOLLOW','PARTAGE','VIRAL','WOW','CLIP','ICI','ABONNE',
    'RESTE','TOP','GO','FYP','TREND',
  ];
  const words = [];
  let t = 0, i = 0;
  while (t < totalDuration - 0.1) {
    const d   = 0.36 + (i % 4) * 0.04;
    const end = Math.min(t + d, totalDuration);
    if (end - t < 0.12) break;
    words.push({ word: hooks[i % hooks.length], start: t, end });
    t = end + 0.08; i++;
  }
  return words;
}
function writeASS(words, segStart, filePath, pw, ph) {
  const fsz = Math.max(42, Math.round(88 * (pw / 1080)));
  const px  = Math.round(pw / 2);
  const py  = Math.round(ph * 0.886);
  const mv  = Math.max(60, Math.round(120 * (ph / 1920)));
  function toT(t) {
    const r = t - segStart, h = Math.floor(r/3600), m = Math.floor((r%3600)/60), s = Math.floor(r%60), cs = Math.round((r%1)*100);
    return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
  }
  const esc2 = s => String(s).replace(/\\/g,'\\\\').replace(/\{/g,'\\{').replace(/\}/g,'\\}');
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${pw}\nPlayResY: ${ph}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Word,Arial Black,${fsz},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,${mv},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  let lines = words.map(w =>
    `Dialogue: 0,${toT(w.start)},${toT(w.end)},Word,,0,0,0,,{\\an2\\pos(${px},${py})\\fad(55,35)\\fscx108\\fscy108\\3c&H000000&\\b1}${esc2(w.word).toUpperCase()}`
  ).join('\n');
  if (!lines.trim()) lines = `Dialogue: 0,0:00:00.00,0:00:01.00,Word,,0,0,0,,{\\an2\\pos(${px},${py})}CLIP`;
  fs.writeFileSync(filePath, header + lines, 'utf8');
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. PUBLICATION (TikTok Content Posting API v2)
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/publish', async (req, res) => {
  const { shorts, accounts } = req.body;
  const pubId = uuidv4();
  res.json({ pubId });
  runPublishJob(pubId, accounts || [], shorts || []).catch(e => console.error('[publish]', e));
});

async function runPublishJob(pubId, accountIds, shorts) {
  for (const accId of accountIds) {
    const acc = tokenStore[accId];
    if (!acc) continue;
    for (const short of shorts) {
      try {
        let result;
        if (acc.network === 'tiktok') result = await uploadTikTok(acc, short);
        broadcast(pubId, 'published', { accId, shortId: short.id, network: acc.network, username: acc.username, result });
      } catch (e) {
        broadcast(pubId, 'publish_error', { accId, shortId: short.id, error: e.message });
      }
    }
  }
  broadcast(pubId, 'publish_done', {});
}

// ─── TikTok upload (Content Posting API Direct Post) ─────────────────────────
async function refreshTikTok(acc) {
  if (!acc.refreshToken) throw new Error('TikTok: pas de refresh_token (reconnecte le compte)');
  const { data } = await axios.post(OAUTH.tiktok.tokenUrl,
    new URLSearchParams({ client_key: OAUTH.tiktok.clientKey, client_secret: OAUTH.tiktok.clientSecret, grant_type: 'refresh_token', refresh_token: acc.refreshToken }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  if (data.error) throw new Error(data.error_description || data.error);
  acc.accessToken    = data.access_token;
  if (data.refresh_token) acc.refreshToken = data.refresh_token;
  acc.tokenExpiresAt = Number(data.expires_in) > 0 ? Date.now() + Number(data.expires_in) * 1000 : 0;
  acc._creatorCtx    = null;
  saveTokens();
}

async function ensureToken(acc) {
  if (!acc.refreshToken) return;
  if (acc.tokenExpiresAt && Date.now() < acc.tokenExpiresAt - 300000) return;
  await refreshTikTok(acc);
}

async function getCreatorCtx(acc) {
  if (acc._creatorCtx) return acc._creatorCtx;
  const { data } = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
    {},
    { headers: { Authorization: `Bearer ${acc.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
  );
  if (data.error?.code !== 'ok') throw new Error(data.error?.message || 'TikTok creator_info');
  const d    = data.data || {};
  const opts = d.privacy_level_options || [];
  const preferred = (process.env.TIKTOK_PRIVACY_LEVEL || '').trim();
  const privacy = (preferred && opts.includes(preferred))
    ? preferred
    : (opts.includes('SELF_ONLY') ? 'SELF_ONLY' : opts[0]);
  if (!privacy) throw new Error('TikTok: aucune option confidentialité');
  acc._creatorCtx = {
    privacy_level:            privacy,
    disable_comment:          !!d.comment_disabled,
    disable_duet:             !!d.duet_disabled,
    disable_stitch:           !!d.stitch_disabled,
    max_video_post_duration_sec: Number(d.max_video_post_duration_sec) || 600,
  };
  return acc._creatorCtx;
}

async function uploadTikTok(acc, short) {
  await ensureToken(acc);
  try { return await doUpload(acc, short); }
  catch (e) {
    if ([401, 403].includes(e.response?.status) && acc.refreshToken) {
      await refreshTikTok(acc);
      return await doUpload(acc, short);
    }
    throw e;
  }
}

async function doUpload(acc, short) {
  const videoSize = fs.statSync(short.localPath).size;
  const ctx = await getCreatorCtx(acc);
  const dur = Number(short.duration);
  if (Number.isFinite(dur) && dur > ctx.max_video_post_duration_sec + 0.5) {
    throw new Error(`TikTok: vidéo trop longue (max ${ctx.max_video_post_duration_sec}s pour ce compte)`);
  }
  const maxChunk    = 10 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(videoSize / maxChunk));
  const chunkSize   = totalChunks === 1 ? videoSize : maxChunk;

  const { data: init } = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/video/init/',
    {
      post_info: {
        title:           short.title || `Short #${short.id}`,
        privacy_level:   ctx.privacy_level,
        disable_duet:    ctx.disable_duet,
        disable_stitch:  ctx.disable_stitch,
        disable_comment: ctx.disable_comment,
      },
      source_info: { source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: chunkSize, total_chunk_count: totalChunks },
    },
    { headers: { Authorization: `Bearer ${acc.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
  );
  if (init.error?.code !== 'ok') throw new Error(init.error?.message || init.error?.code || 'TikTok init');
  const { upload_url, publish_id } = init.data || {};
  if (!upload_url) throw new Error('TikTok: pas d\'upload_url');

  const buf = fs.readFileSync(short.localPath);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end   = Math.min(start + chunkSize, buf.length) - 1;
    const chunk = buf.subarray(start, end + 1);
    await axios.put(upload_url, chunk, {
      maxBodyLength: Infinity, maxContentLength: Infinity,
      headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': chunk.length },
    });
  }
  return publish_id;
}

// ═════════════════════════════════════════════════════════════════════════════
//  START
// ═════════════════════════════════════════════════════════════════════════════
function onListenErr(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} déjà utilisé. Lance avec un autre port : PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
}
server.on('error', onListenErr);
wss.on('error', onListenErr);

server.listen(PORT, () => {
  const base = publicBase();
  if (!LEGAL_PAGES.terms || !LEGAL_PAGES.privacy) {
    console.error('\n   ⚠  Pages légales manquantes (/public/legal). TikTok refusera les URLs tant que le déploiement n’inclut pas ces fichiers.\n');
  }
  console.log(`\n🚀 ShortFactory → http://localhost:${PORT}`);
  console.log(`   ${SHORT_SEGMENT_SEC}s/short · max ${GEN_MAX_SHORTS} · budget ${GEN_BUDGET_MS/1000}s · ${ENCODE_PARALLEL}× parallèle · ${ENCODE_PRESET} · subs:${SUBTITLE_BURN}`);
  if (base) {
    console.log(`\n   ✅ URLs TikTok Developers (HTTPS actif) :`);
    console.log(`     Terms of Service : ${base}/legal/terms`);
    console.log(`     Privacy Policy   : ${base}/legal/privacy`);
    console.log(`     Redirect URI     : ${OAUTH.tiktok.redirectUri}`);
    console.log(`     Webhook URL      : ${base}/api/tiktok/webhook\n`);
  }
  if (!OAUTH.tiktok.clientKey || !OAUTH.tiktok.clientSecret) {
    console.warn('   ⚠  TikTok: TIKTOK_CLIENT_KEY et TIKTOK_CLIENT_SECRET manquants dans .env\n');
  }
});
