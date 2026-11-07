import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import Database from 'better-sqlite3';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfg = {
  port: +process.env.PORT || 3001,
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  maxUploadMB: +process.env.MAX_UPLOAD_MB || 200,
  maxDurationMin: +process.env.MAX_DURATION_MIN || 60,
  ttlMin: +process.env.FILE_TTL_MIN || 60,
  maxJobs: +process.env.MAX_CONCURRENT_JOBS || 2,
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  ytKey: process.env.YOUTUBE_API_KEY || '',
};

// ---------- Armazenamento ----------
const DATA = path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
const OUT = path.join(DATA, 'out');
fs.mkdirSync(UP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const db = new Database(path.join(DATA, 'nekotube.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS uploads(
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
  duration REAL, height INTEGER, has_video INTEGER, has_audio INTEGER, thumb TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, name TEXT NOT NULL, thumb TEXT,
  format TEXT NOT NULL, quality TEXT NOT NULL, size INTEGER, status TEXT NOT NULL,
  file_path TEXT, error TEXT, created_at INTEGER NOT NULL, expires_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_items_client ON items(client_id, created_at);
`);

const rid = () => crypto.randomBytes(16).toString('hex');
const rmSafe = (p) => { if (p) try { fs.unlinkSync(p); } catch {} };
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const cleanName = (n) =>
  Buffer.from(String(n), 'latin1').toString('utf8')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\.[^.]*$/, '').trim().slice(0, 120) || 'arquivo';

function clientId(req) {
  const c = req.get('x-client-id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(c)) throw httpErr(400, 'Sessão inválida. Recarregue a página.');
  return c;
}

// Marca como erro o que ficou "processando" após reinício e apaga arquivos órfãos
db.prepare("UPDATE items SET status='error', error='Interrompido por reinício do servidor.' WHERE status='processing'").run();
{
  const known = new Set([
    ...db.prepare('SELECT path FROM uploads').all().map((r) => r.path),
    ...db.prepare('SELECT file_path p FROM items WHERE file_path IS NOT NULL').all().map((r) => r.p),
  ]);
  for (const dir of [UP, OUT]) for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (!known.has(p)) rmSafe(p);
  }
}

function cleanup() {
  const now = Date.now();
  for (const r of db.prepare("SELECT id, file_path FROM items WHERE status='done' AND expires_at < ?").all(now)) {
    rmSafe(r.file_path);
    db.prepare("UPDATE items SET status='expired', file_path=NULL WHERE id=?").run(r.id);
  }
  for (const r of db.prepare('SELECT id, path FROM uploads WHERE created_at < ?').all(now - cfg.ttlMin * 60000)) {
    rmSafe(r.path);
    db.prepare('DELETE FROM uploads WHERE id=?').run(r.id);
  }
}
cleanup();
setInterval(cleanup, 60_000).unref();

// ---------- FFmpeg ----------
let ffmpegOk = false;
try { await execFileP(cfg.ffmpeg, ['-version'], { timeout: 8000 }); await execFileP(cfg.ffprobe, ['-version'], { timeout: 8000 }); ffmpegOk = true; }
catch { console.warn('⚠ FFmpeg/FFprobe não encontrados. Instale-os ou defina FFMPEG_PATH/FFPROBE_PATH.'); }

async function probe(file) {
  const { stdout } = await execFileP(cfg.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeout: 20000, maxBuffer: 5e6 });
  const j = JSON.parse(stdout);
  const s = j.streams || [];
  const v = s.find((x) => x.codec_type === 'video' && !x.disposition?.attached_pic);
  const a = s.find((x) => x.codec_type === 'audio');
  return { duration: parseFloat(j.format?.duration) || 0, height: v?.height || 0, hasVideo: !!v, hasAudio: !!a };
}

async function makeThumb(file, dur) {
  try {
    const { stdout } = await execFileP(cfg.ffmpeg,
      ['-v', 'error', '-ss', String(Math.min(1, dur / 2)), '-i', file, '-frames:v', '1',
       '-vf', 'scale=320:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
      { encoding: 'buffer', timeout: 20000, maxBuffer: 2e6 });
    return stdout.length ? 'data:image/jpeg;base64,' + stdout.toString('base64') : null;
  } catch { return null; }
}

const AUDIO_FORMATS = { mp3: ['-c:a', 'libmp3lame'], m4a: ['-c:a', 'aac', '-movflags', '+faststart'], wav: ['-c:a', 'pcm_s16le'] };
const BITRATES = [128, 192, 320];
const HEIGHTS = [360, 480, 720, 1080];
const videoHeights = (h) => { const l = HEIGHTS.filter((x) => x <= h); return l.length ? l : [h - (h % 2)]; };

// ---------- Jobs ----------
const jobs = new Map(); // id -> { proc, progress, canceled }

function runJob(item, up, args, duration) {
  const job = { proc: null, progress: 0, canceled: false };
  jobs.set(item.id, job);
  let finished = false, errTail = '', buf = '';
  const finish = (status, error) => {
    if (finished) return; finished = true; jobs.delete(item.id);
    if (status === 'done') {
      const size = fs.statSync(item.file_path).size;
      db.prepare('UPDATE items SET status=?, size=?, expires_at=? WHERE id=?').run('done', size, Date.now() + cfg.ttlMin * 60000, item.id);
    } else {
      rmSafe(item.file_path);
      db.prepare('UPDATE items SET status=?, error=?, file_path=NULL WHERE id=?').run(status, error || null, item.id);
    }
  };
  const proc = spawn(cfg.ffmpeg,
    ['-hide_banner', '-nostdin', '-y', '-i', up.path, ...args, '-progress', 'pipe:1', '-nostats', item.file_path],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = proc;
  proc.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m) job.progress = Math.min(99, Math.floor((+m[1] / 1e6 / duration) * 100));
    }
  });
  proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
  proc.on('error', () => finish('error', 'Não foi possível executar o FFmpeg.'));
  proc.on('close', (code) => {
    if (job.canceled) return finish('canceled', 'Cancelado pelo usuário.');
    if (code === 0) return finish('done');
    console.error('FFmpeg falhou:', errTail);
    finish('error', 'A conversão falhou. O arquivo pode estar corrompido ou usar um formato não suportado.');
  });
}

const publicItem = (r, live) => ({
  id: r.id, name: r.name, thumb: r.thumb, format: r.format, quality: r.quality, size: r.size,
  status: r.status, error: r.error, createdAt: r.created_at,
  progress: live ? live.progress : r.status === 'done' ? 100 : 0,
  downloadable: r.status === 'done' && !!r.file_path && fs.existsSync(r.file_path),
});

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: cfg.origin, allowedHeaders: ['Content-Type', 'x-client-id'] }));
app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde um instante.' } }));

const ALLOWED_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const upload = multer({
  storage: multer.diskStorage({ destination: UP, filename: (_r, _f, cb) => cb(null, rid() + '.bin') }),
  limits: { fileSize: cfg.maxUploadMB * 1024 * 1024, files: 1 },
  fileFilter: (_r, f, cb) => ALLOWED_EXT.has(path.extname(f.originalname).toLowerCase())
    ? cb(null, true) : cb(httpErr(415, 'Formato não suportado. Envie MP4, MKV, WEBM, MOV, AVI, MP3, WAV, M4A, AAC, OGG ou FLAC.')),
});

app.get('/api/config', (_req, res) => res.json({
  ffmpeg: ffmpegOk, youtubeConfigured: !!cfg.ytKey, maxUploadMB: cfg.maxUploadMB,
  maxDurationMin: cfg.maxDurationMin, ttlMin: cfg.ttlMin,
}));

// --- Análise de link do YouTube (somente metadados oficiais) ---
function parseYouTube(raw) {
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (h === 'youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/); if (m) id = m[2]; }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}
const isoDur = (s) => { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null; };

app.post('/api/analyze', async (req, res) => {
  clientId(req);
  const id = parseYouTube(String(req.body?.url || ''));
  if (!id) throw httpErr(400, 'Esse não parece um link válido do YouTube.');
  const out = { kind: 'youtube', videoId: id, title: '', channel: '', thumbnail: '', duration: null, warnings: [],
    availability: { downloadable: false, label: 'Download direto indisponível',
      reason: 'O YouTube não oferece uma API oficial para baixar vídeos, e o NekoTube não contorna proteções. Se o conteúdo é seu ou tem licença que permita, envie o arquivo original abaixo para converter.' } };
  try {
    if (cfg.ytKey) {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${id}&key=${encodeURIComponent(cfg.ytKey)}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw httpErr(502, 'A YouTube Data API recusou a consulta. Verifique a YOUTUBE_API_KEY.');
      const it = (await r.json()).items?.[0];
      if (!it) throw httpErr(404, 'Vídeo não encontrado, privado ou removido.');
      out.title = it.snippet.title; out.channel = it.snippet.channelTitle;
      out.thumbnail = it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || '';
      out.duration = isoDur(it.contentDetails?.duration);
    } else {
      const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 404 || r.status === 401 || r.status === 403) throw httpErr(404, 'Vídeo indisponível, privado ou removido.');
      if (!r.ok) throw httpErr(502, 'Não foi possível consultar o YouTube agora.');
      const j = await r.json();
      out.title = j.title; out.channel = j.author_name; out.thumbnail = j.thumbnail_url;
      out.warnings.push('Duração indisponível: configure YOUTUBE_API_KEY no backend para exibi-la.');
    }
  } catch (e) {
    if (e.status) throw e;
    throw httpErr(504, 'Tempo esgotado ao consultar o YouTube. Tente novamente.');
  }
  res.json(out);
});

// --- Upload + inspeção ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const cid = clientId(req);
  if (!req.file) throw httpErr(400, 'Nenhum arquivo enviado.');
  if (!ffmpegOk) { rmSafe(req.file.path); throw httpErr(503, 'FFmpeg não está configurado no servidor.'); }
  let info;
  try { info = await probe(req.file.path); }
  catch { rmSafe(req.file.path); throw httpErr(415, 'Esse arquivo não é uma mídia válida.'); }
  if (!info.hasAudio && !info.hasVideo) { rmSafe(req.file.path); throw httpErr(415, 'Nenhuma faixa de áudio ou vídeo encontrada.'); }
  if (!info.duration) { rmSafe(req.file.path); throw httpErr(415, 'Não foi possível determinar a duração do arquivo.'); }
  if (info.duration > cfg.maxDurationMin * 60) { rmSafe(req.file.path); throw httpErr(413, `Duração acima do limite de ${cfg.maxDurationMin} minutos.`); }
  const thumb = info.hasVideo ? await makeThumb(req.file.path, info.duration) : null;
  const id = rid(), name = cleanName(req.file.originalname);
  db.prepare('INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, cid, req.file.path, name, info.duration, info.height, +info.hasVideo, +info.hasAudio, thumb, Date.now());
  res.json({ uploadId: id, name, size: req.file.size, duration: info.duration, thumb,
    hasAudio: info.hasAudio, hasVideo: info.hasVideo,
    audio: { formats: Object.keys(AUDIO_FORMATS), bitrates: BITRATES },
    video: { formats: ['mp4'], heights: info.hasVideo ? videoHeights(info.height) : [] } });
});

// --- Conversão ---
app.post('/api/convert', (req, res) => {
  const cid = clientId(req);
  if (!ffmpegOk) throw httpErr(503, 'FFmpeg não está configurado no servidor.');
  if (jobs.size >= cfg.maxJobs) throw httpErr(429, 'Muitas conversões em andamento. Tente novamente em instantes.');
  const { uploadId, mode, format } = req.body || {};
  const up = db.prepare('SELECT * FROM uploads WHERE id=? AND client_id=?').get(String(uploadId), cid);
  if (!up || !fs.existsSync(up.path)) throw httpErr(404, 'Arquivo expirou. Envie-o novamente.');
  let args, ext, quality;
  if (mode === 'audio') {
    if (!AUDIO_FORMATS[format]) throw httpErr(400, 'Formato de áudio inválido.');
    if (!up.has_audio) throw httpErr(400, 'Este arquivo não possui áudio.');
    ext = format;
    const br = BITRATES.includes(+req.body.quality) ? +req.body.quality : 192;
    args = ['-map', '0:a:0', '-vn', ...AUDIO_FORMATS[format], ...(format === 'wav' ? [] : ['-b:a', `${br}k`])];
    quality = format === 'wav' ? 'Sem perdas' : `${br} kbps`;
  } else if (mode === 'video') {
    if (format !== 'mp4') throw httpErr(400, 'Formato de vídeo inválido.');
    if (!up.has_video) throw httpErr(400, 'Este arquivo não possui vídeo.');
    const h = +req.body.quality;
    if (!videoHeights(up.height).includes(h)) throw httpErr(400, 'Qualidade indisponível para este arquivo.');
    ext = 'mp4'; quality = `${h}p`;
    args = ['-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=-2:${h}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
  } else throw httpErr(400, 'Modo inválido.');

  const id = rid();
  const item = { id, client_id: cid, name: up.name, thumb: up.thumb, format: ext.toUpperCase(), quality,
    status: 'processing', file_path: path.join(OUT, `${id}.${ext}`), created_at: Date.now() };
  db.prepare('INSERT INTO items(id,client_id,name,thumb,format,quality,status,file_path,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(item.id, cid, item.name, item.thumb, item.format, item.quality, item.status, item.file_path, item.created_at);
  runJob(item, up, args, up.duration);
  res.status(202).json({ jobId: id });
});

const ownItem = (req) => {
  const r = db.prepare('SELECT * FROM items WHERE id=? AND client_id=?').get(req.params.id, clientId(req));
  if (!r) throw httpErr(404, 'Item não encontrado.');
  return r;
};

app.get('/api/jobs/:id', (req, res) => { const r = ownItem(req); res.json(publicItem(r, jobs.get(r.id))); });

app.post('/api/jobs/:id/cancel', (req, res) => {
  const r = ownItem(req); const job = jobs.get(r.id);
  if (!job) throw httpErr(409, 'Esta conversão não está mais em andamento.');
  job.canceled = true; job.proc.kill('SIGKILL');
  res.json({ ok: true });
});

app.get('/api/download/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM items WHERE id=?').get(String(req.params.id));
  if (!r || r.status !== 'done' || !r.file_path || !fs.existsSync(r.file_path))
    throw httpErr(404, 'Arquivo indisponível ou expirado.');
  res.download(r.file_path, `${r.name}.${r.format.toLowerCase()}`);
});

// --- Biblioteca ---
app.get('/api/library', (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE client_id=? ORDER BY created_at DESC LIMIT 200').all(clientId(req));
  res.json(rows.map((r) => publicItem(r, jobs.get(r.id))));
});

app.delete('/api/library/:id', (req, res) => {
  const r = ownItem(req); const job = jobs.get(r.id);
  if (job) { job.canceled = true; job.proc.kill('SIGKILL'); }
  rmSafe(r.file_path); db.prepare('DELETE FROM items WHERE id=?').run(r.id);
  res.json({ ok: true });
});

app.delete('/api/library', (req, res) => {
  const cid = clientId(req);
  for (const r of db.prepare('SELECT id, file_path FROM items WHERE client_id=?').all(cid)) {
    const job = jobs.get(r.id); if (job) { job.canceled = true; job.proc.kill('SIGKILL'); }
    rmSafe(r.file_path);
  }
  db.prepare('DELETE FROM items WHERE client_id=?').run(cid);
  res.json({ ok: true });
});

app.use('/api', (_req, _res, next) => next(httpErr(404, 'Rota não encontrada.')));
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Arquivo maior que o limite de ${cfg.maxUploadMB} MB.` });
  if (err.name === 'MulterError') return res.status(400).json({ error: 'Falha no envio do arquivo.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requisição inválida.' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno. Tente novamente.' });
});

const server = app.listen(cfg.port, () => console.log(`🐾 NekoTube API em http://localhost:${cfg.port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const j of jobs.values()) j.proc?.kill('SIGKILL');
  server.close(() => process.exit(0));
});
