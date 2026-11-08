// Importação de mídia por link para fontes públicas e autorizadas.
// Não usa cookies de navegador, sessões, credenciais ou métodos para contornar DRM/paywalls.
import { spawn, execFile } from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const err = (status, message, code) => Object.assign(new Error(message), { status, code });

export const DEFAULT_HOSTS = [
  'archive.org', 'commons.wikimedia.org', 'upload.wikimedia.org', 'media.ccc.de',
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'instagram.com',
  'tiktok.com',
  'x.com', 'twitter.com'
];

const PLATFORM_HOSTS = {
  youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  x: ['x.com', 'twitter.com']
};
const under = (h, d) => h === d || h.endsWith('.' + d);

export function detectPlatform(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return 'unknown'; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  for (const [platform, domains] of Object.entries(PLATFORM_HOSTS)) {
    if (domains.some((d) => under(host, d))) return platform;
  }
  return 'other';
}

export function allowedHosts(extra = '') {
  const more = String(extra).split(',').map((s) => s.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h));
  return [...new Set([...DEFAULT_HOSTS, ...more])];
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

const defaultLookup = (h) => dns.promises.lookup(h, { all: true });

export async function validateImportUrl(raw, hosts, lookup = defaultLookup) {
  const list = hosts.join(', ');
  let u;
  try { u = new URL(String(raw || '').trim()); }
  catch { throw err(400, 'Link inválido. Cole um endereço completo, começando com https://'); }
  if (u.protocol !== 'https:') throw err(400, 'Só são aceitos links https://');
  if (u.username || u.password) throw err(400, 'Links com usuário ou senha não são aceitos.');
  if (u.port && u.port !== '443') throw err(400, 'Porta não permitida.');

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host)) throw err(400, 'Endereços IP não são aceitos.');
  if (!hosts.some((d) => under(host, d))) {
    throw err(400, `Fonte não permitida. Fontes habilitadas: ${list}.`);
  }

  let addrs;
  try { addrs = await lookup(host); }
  catch { throw err(502, 'Não foi possível resolver o endereço desse link.'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw err(400, 'Endereço de destino não permitido.');
  }
  return u.toString();
}

function mapError(stderr) {
  const output = String(stderr || '');
  console.error('yt-dlp:', output.slice(-600));
  if (/Unsupported URL/i.test(output)) return err(422, 'Esse tipo de link ainda não é suportado pelo yt-dlp.');
  if (/HTTP Error 40[134]|private|login|sign in|members|cookies/i.test(output)) {
    return err(422, 'Essa mídia exige autenticação, não é pública ou não está disponível para download.');
  }
  if (/DRM|widevine|encrypted|protected/i.test(output)) {
    return err(422, 'Essa mídia possui proteção contra download e não pode ser importada.');
  }
  return err(422, 'Não foi possível acessar essa mídia. Verifique se o link está público e tente novamente.');
}

export function ytdlpInfo(bin, url) {
  return new Promise((resolve, reject) => {
    execFile(bin, [
      '--ignore-config', '--no-playlist', '--no-warnings',
      '--skip-download', '--dump-single-json', '--socket-timeout', '15', '--', url
    ], { timeout: 45000, maxBuffer: 8e6 }, (e, out, stderr) => {
      if (e) return reject(e.code === 'ENOENT'
        ? err(503, 'yt-dlp não está instalado no servidor.', 'noytdlp')
        : mapError(stderr || e.message));
      try {
        const j = JSON.parse(out);
        const thumb = typeof j.thumbnail === 'string' && j.thumbnail.startsWith('https://') ? j.thumbnail : '';
        resolve({
          title: String(j.title || 'Mídia importada'),
          channel: String(j.uploader || j.channel || j.creator || ''),
          duration: Number.isFinite(j.duration) ? j.duration : null,
          thumbnail: thumb,
          platform: detectPlatform(url)
        });
      } catch { reject(err(422, 'A fonte não retornou informações válidas.')); }
    });
  });
}

const listFiles = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const purge = (dir, id, keep) => {
  for (const f of listFiles(dir)) {
    if (f.startsWith(id + '.') && path.join(dir, f) !== keep) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  }
};

// Baixa apenas mídia que o extrator consegue acessar sem sessão/cookies ou bypass de proteção.
export function ytdlpDownload({ bin, url, dir, id, maxBytes, maxDurationSec, onProgress, onProc, isCanceled }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--ignore-config', '--no-playlist', '--no-warnings',
      '--newline', '--no-part', '--no-mtime', '--restrict-filenames',
      '--socket-timeout', '15', '--retries', '2',
      '--max-filesize', String(maxBytes),
      '--match-filter', `duration<=${maxDurationSec}?`,
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format', 'mkv',
      '--progress-template', 'download:NKP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
      '-o', path.join(dir, id + '.%(ext)s'), '--', url
    ];

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onProc?.(proc);
    let buf = '', tail = '', tooBig = false, settled = false;

    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = line.match(/^NKP (\S+) (\S+) (\S+)$/);
        if (!m) { tail = (tail + line + '\n').slice(-1500); continue; }
        const done = +m[1], total = +m[2] || +m[3];
        if (done > maxBytes) { tooBig = true; proc.kill('SIGKILL'); return; }
        if (total > 0) onProgress?.(Math.max(0, Math.min(99, Math.floor(done / total * 100))));
      }
    });
    proc.stderr.on('data', (d) => { tail = (tail + d).slice(-1500); });
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e.code === 'ENOENT'
        ? err(503, 'yt-dlp não está instalado no servidor.', 'noytdlp')
        : err(500, 'Falha ao iniciar o yt-dlp.'));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (isCanceled?.()) { purge(dir, id); return reject(err(499, 'Importação cancelada.', 'canceled')); }
      if (tooBig) { purge(dir, id); return reject(err(413, 'O arquivo é maior que o limite permitido.')); }

      const files = listFiles(dir).filter((f) =>
        f.startsWith(id + '.') && !/\.(part|ytdl|tmp)$/.test(f));
      if (code !== 0 || !files.length) {
        purge(dir, id);
        if (code === 0) return reject(err(413, 'A mídia excede os limites de tamanho/duração ou não está disponível.'));
        return reject(mapError(tail));
      }
      const final = path.join(dir, files[0]);
      purge(dir, id, final);
      resolve(final);
    });
  });
}
