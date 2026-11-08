// Testes do módulo de importação (sem rede): validação anti-SSRF e ciclo de download com um yt-dlp simulado.
// Rodar: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedHosts, validateImportUrl, ytdlpDownload, isPrivateIp } from '../importer.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-'));
const fake = path.join(tmp, 'fake-ytdlp.sh');
fs.writeFileSync(fake, `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o) OUT="$2"; shift;; esac; shift; done
case "$FAKE_MODE" in
  fail) echo "ERROR: Unsupported URL" >&2; exit 1;;
  nofile) echo "does not pass filter"; exit 0;;
esac
for p in 10 40 70 100; do echo "NKP $((p*1000)) 100000 NA"; sleep 0.2; done
[ "$FAKE_MODE" = "slow" ] && sleep 5
head -c 2048 /dev/zero > "\${OUT/\\%(ext)s/mp3}"
`, { mode: 0o755 });

const hosts = allowedHosts('exemplo.org,youtube.com');
const pub = async () => [{ address: '93.184.216.34' }];
const priv = async () => [{ address: '10.0.0.5' }];
const blocked = async (u, l = pub) => { try { await validateImportUrl(u, hosts, l); return null; } catch (e) { return e.message; } };
const run = (id, extra = {}) => ytdlpDownload({ bin: fake, url: 'https://archive.org/x', dir: tmp, id, maxBytes: 5e6, maxDurationSec: 3600, ...extra });

assert(!hosts.includes('youtube.com'), 'YouTube nunca entra na lista de fontes');
for (const ok of ['https://archive.org/details/x', 'https://ia800.us.archive.org/a.mp3', 'https://exemplo.org/v'])
  assert.equal(await blocked(ok), null, ok);
for (const bad of ['http://archive.org/x', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ',
  'https://evil.com/x', 'https://archive.org.evil.com/x', 'https://user:pw@archive.org/x', 'https://archive.org:8080/x',
  'https://127.0.0.1/x', 'https://[::1]/x', 'file:///etc/passwd', 'lixo', 'https://169.254.169.254/'])
  assert(await blocked(bad), 'deveria bloquear ' + bad);
assert(await blocked('https://archive.org/x', priv), 'DNS privado deve ser bloqueado');
assert(isPrivateIp('192.168.1.1') && isPrivateIp('::ffff:127.0.0.1') && !isPrivateIp('8.8.8.8'));
console.log('✔ validação de URL / SSRF');

process.env.FAKE_MODE = 'ok';
const prog = [];
const file = await run('ok1', { onProgress: (p) => prog.push(p) });
assert(fs.existsSync(file) && file.endsWith('.mp3'));
assert.deepEqual(prog, [10, 40, 70, 99]);
console.log('✔ download com progresso real:', prog.join(', '));

process.env.FAKE_MODE = 'fail';
await assert.rejects(run('e1'), /não é suportado/);
process.env.FAKE_MODE = 'nofile';
await assert.rejects(run('e2'), /limites/);
process.env.FAKE_MODE = 'slow';
let proc, canceled = false;
const p = run('c1', { onProc: (x) => (proc = x), isCanceled: () => canceled });
setTimeout(() => { canceled = true; proc.kill('SIGKILL'); }, 400);
await assert.rejects(p, (e) => e.code === 'canceled');
assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('c1')), []);
await assert.rejects(ytdlpDownload({ bin: '/nao/existe', url: 'https://archive.org/x', dir: tmp, id: 'n1', maxBytes: 1, maxDurationSec: 1 }), (e) => e.code === 'noytdlp');
console.log('✔ erros, cancelamento (sem arquivos temporários) e yt-dlp ausente');
fs.rmSync(tmp, { recursive: true, force: true });
