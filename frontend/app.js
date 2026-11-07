'use strict';
const API = (window.NEKOTUBE_API || 'http://localhost:3001').replace(/\/$/, '');
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  kids.flat().forEach((c) => e.append(c));
  return e;
};
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const cid = (() => {
  let id = store.get('nk_cid', null);
  if (!id) { id = crypto.randomUUID(); store.set('nk_cid', id); }
  return id;
})();

const fmtDur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtDate = (t) => new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const STATUS = { processing: 'Processando', done: 'Concluído', error: 'Erro', canceled: 'Cancelado', expired: 'Expirado' };

async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-client-id': cid, ...(opts.headers || {}) } });
  } catch { throw new Error('Não foi possível conectar ao servidor do NekoTube. Verifique se o backend está em execução.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Algo deu errado. Tente novamente.');
  return data;
}

// ---------- Configurações / tema ----------
const settings = { theme: store.get('nk_theme', 'dark'), msgs: store.get('nk_msgs', true), stars: store.get('nk_stars', true) };
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  $('#optTheme').checked = settings.theme === 'dark';
  $('#optMsgs').checked = settings.msgs;
  $('#optStars').checked = settings.stars;
  store.set('nk_theme', settings.theme); store.set('nk_msgs', settings.msgs); store.set('nk_stars', settings.stars);
}
$('#themeBtn').onclick = () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; applySettings(); };
$('#optTheme').onchange = (e) => { settings.theme = e.target.checked ? 'dark' : 'light'; applySettings(); };
$('#optMsgs').onchange = (e) => { settings.msgs = e.target.checked; applySettings(); };
$('#optStars').onchange = (e) => { settings.stars = e.target.checked; applySettings(); };

// ---------- Estrelas ----------
(function stars() {
  const cv = $('#stars'), ctx = cv.getContext('2d');
  let W, H, list = [];
  const resize = () => {
    W = cv.width = innerWidth; H = cv.height = innerHeight;
    list = Array.from({ length: Math.min(110, Math.floor(W * H / 14000)) }, () => ({
      x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.6 + .3,
      s: Math.random() * .02 + .005, p: Math.random() * 6.28, c: Math.random() < .25 ? '232,165,232' : '133,201,255' }));
  };
  addEventListener('resize', resize); resize();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  (function draw(t = 0) {
    ctx.clearRect(0, 0, W, H);
    if (settings.stars) for (const s of list) {
      const a = still ? .6 : .25 + .75 * Math.abs(Math.sin(s.p + t * s.s));
      ctx.fillStyle = `rgba(${s.c},${a})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.28); ctx.fill();
    }
    if (!still) requestAnimationFrame(draw);
  })();
})();

// ---------- Utilidades de UI ----------
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 4500); }
function showError(msg) { const e = $('#urlError'); e.textContent = msg; e.hidden = !msg; }
const show = (sel, on = true) => ($(sel).hidden = !on);
const MSG = {
  audio: ['A Grande e Poderosa Trixie aprova esta conversão!', 'Trixie garante: nenhum truque, só talento.', 'Até a plateia mais difícil aplaudiria este áudio!'],
  video: ['Mais uma pequena magia concluída!', 'Starlight confirma: tudo em perfeita harmonia.', 'Mágica bem-feita, do jeito certo.'],
};
const randomMsg = (mode) => MSG[mode][Math.floor(Math.random() * MSG[mode].length)];

let cfg = null, upload = null, activeJob = null, lastMode = 'audio';

// ---------- Análise de link ----------
$('#analyzeForm').onsubmit = async (e) => {
  e.preventDefault(); showError('');
  const url = $('#url').value.trim();
  if (!url) return showError('Cole um link do YouTube para começar.');
  const btn = $('#analyzeBtn'); btn.disabled = true; btn.textContent = 'ANALISANDO…';
  try { renderMedia(await api('/api/analyze', { method: 'POST', body: JSON.stringify({ url }) })); }
  catch (err) { showError(err.message); show('#mediaPanel', false); }
  finally { btn.disabled = false; btn.textContent = 'ANALISAR VÍDEO'; }
};

function renderMedia(m) {
  const p = $('#mediaPanel'); p.replaceChildren(
    el('div', { class: 'media' },
      m.thumbnail ? el('img', { src: m.thumbnail, alt: '', referrerpolicy: 'no-referrer' }) : '',
      el('div', {},
        el('h3', {}, m.title), el('div', { class: 'muted' }, 'Canal: ' + m.channel),
        el('div', { class: 'muted' }, 'Duração: ' + (m.duration != null ? fmtDur(m.duration) : 'indisponível')),
        el('span', { class: 'badge' }, m.availability.label),
        el('p', { class: 'muted small' }, m.availability.reason),
        ...m.warnings.map((w) => el('p', { class: 'muted small' }, 'ℹ ' + w)))));
  show('#mediaPanel'); p.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const d = $('#drop'); d.classList.add('hint'); setTimeout(() => d.classList.remove('hint'), 3500);
}

// ---------- Upload ----------
const drop = $('#drop');
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
$('#file').onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; };

function sendFile(file) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('POST', API + '/api/upload'); x.setRequestHeader('x-client-id', cid);
    const fd = new FormData(); fd.append('file', file);
    x.upload.onprogress = (e) => { if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); $('#upPct').textContent = p + '%'; $('#upBar').style.width = p + '%'; } };
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(d) : reject(new Error(d.error || 'Falha no envio do arquivo.')); };
    x.onerror = () => reject(new Error('Não foi possível conectar ao servidor do NekoTube.'));
    x.send(fd);
  });
}

async function handleFile(file) {
  showError('');
  if (cfg && file.size > cfg.maxUploadMB * 1048576) return showError(`Arquivo maior que o limite de ${cfg.maxUploadMB} MB.`);
  show('#options', false); show('#success', false); show('#processing', false);
  $('#upBar').style.width = '0'; $('#upPct').textContent = '0%'; show('#uploadProgress');
  $('#uploadProgress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  try { upload = await sendFile(file); renderOptions(upload); }
  catch (err) { showError(err.message); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  finally { show('#uploadProgress', false); }
}

function fill(sel, opts) { sel.replaceChildren(...opts.map(([v, t]) => el('option', { value: v }, t))); }
function renderOptions(u) {
  show('#mediaPanel', false);
  const p = $('#mediaPanel');
  p.replaceChildren(el('div', { class: 'media' },
    u.thumb ? el('img', { src: u.thumb, alt: '' }) : el('div', { class: 'char' }, '🎵'),
    el('div', {}, el('h3', {}, u.name), el('div', { class: 'muted' }, `Duração: ${fmtDur(u.duration)} · ${fmtSize(u.size)}`),
      el('span', { class: 'badge ok' }, 'Pronto para converter'))));
  show('#mediaPanel');
  fill($('#aFormat'), u.audio.formats.map((f) => [f, f.toUpperCase()]));
  fill($('#aQuality'), u.audio.bitrates.map((b) => [b, b + ' kbps']));
  fill($('#vQuality'), u.video.heights.map((h) => [h, h + 'p']));
  const updQ = () => show('#aQualWrap', $('#aFormat').value !== 'wav');
  $('#aFormat').onchange = updQ; updQ();
  $('#goAudio').disabled = !u.hasAudio; $('#aNote').textContent = u.hasAudio ? '' : 'Este arquivo não possui faixa de áudio.';
  $('#goVideo').disabled = !u.hasVideo; $('#vNote').textContent = u.hasVideo ? '' : 'Este arquivo não possui vídeo.';
  show('#options'); $('#options').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Conversão ----------
async function convert(mode) {
  if (!upload) return;
  lastMode = mode; show('#success', false);
  const body = mode === 'audio'
    ? { uploadId: upload.uploadId, mode, format: $('#aFormat').value, quality: +$('#aQuality').value }
    : { uploadId: upload.uploadId, mode, format: 'mp4', quality: +$('#vQuality').value };
  try {
    const { jobId } = await api('/api/convert', { method: 'POST', body: JSON.stringify(body) });
    activeJob = jobId; $('#pName').textContent = upload.name; setProgress(0, 'Convertendo…');
    $('#cancelBtn').disabled = false; show('#processing'); $('#processing').scrollIntoView({ behavior: 'smooth', block: 'center' });
    poll(jobId);
  } catch (err) { toast(err.message); }
}
function setProgress(p, status) { $('#pBar').style.width = p + '%'; $('#pPct').textContent = p + '%'; $('#pStatus').textContent = status; }
async function poll(id) {
  if (activeJob !== id) return;
  try {
    const j = await api('/api/jobs/' + id);
    if (j.status === 'processing') { setProgress(j.progress, 'Convertendo…'); return setTimeout(() => poll(id), 700); }
    activeJob = null; show('#processing', false); loadLibrary();
    if (j.status === 'done') return renderSuccess(j);
    toast(j.status === 'canceled' ? 'Conversão cancelada.' : j.error || 'A conversão falhou.');
  } catch (err) { activeJob = null; show('#processing', false); toast(err.message); }
}
$('#cancelBtn').onclick = async () => {
  if (!activeJob) return; $('#cancelBtn').disabled = true; $('#pStatus').textContent = 'Cancelando…';
  try { await api(`/api/jobs/${activeJob}/cancel`, { method: 'POST' }); } catch (e) { toast(e.message); }
};
$('#goAudio').onclick = () => convert('audio');
$('#goVideo').onclick = () => convert('video');

function renderSuccess(j) {
  const rows = [['Arquivo', j.name], ['Formato', j.format], ['Tamanho', fmtSize(j.size)], ['Qualidade', j.quality]];
  $('#sInfo').replaceChildren(...rows.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
  $('#dlBtn').href = `${API}/api/download/${j.id}`; $('#dlBtn').setAttribute('download', '');
  const m = $('#magicMsg'); m.hidden = !settings.msgs; if (settings.msgs) m.textContent = '✦ ' + randomMsg(lastMode);
  show('#success'); $('#success').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- Biblioteca ----------
async function loadLibrary() {
  const box = $('#library');
  try {
    const items = await api('/api/library');
    $('#clearAll').hidden = !items.length;
    if (!items.length) return box.replaceChildren(el('div', { class: 'empty' }, 'Sua biblioteca está vazia. As conversões aparecerão aqui.'));
    box.replaceChildren(...items.map((i) => el('div', { class: 'item' },
      el('div', { class: 'th', style: i.thumb ? `background-image:url("${i.thumb}")` : '' }, i.thumb ? '' : '🎵'),
      el('div', { class: 'meta' }, el('b', {}, i.name),
        el('span', {}, `${i.format} · ${i.quality} · ${fmtDate(i.createdAt)} · ${STATUS[i.status] || i.status}${i.status === 'processing' ? ' ' + i.progress + '%' : ''}`)),
      el('div', { class: 'acts' },
        i.downloadable ? el('a', { class: 'btn btn-blue', href: `${API}/api/download/${i.id}`, download: '' }, 'Baixar') : '',
        el('button', { class: 'btn btn-ghost', 'aria-label': 'Excluir ' + i.name, onclick: () => removeItem(i.id) }, 'Excluir')))));
  } catch (err) { box.replaceChildren(el('div', { class: 'empty' }, err.message)); }
}
async function removeItem(id) { try { await api('/api/library/' + id, { method: 'DELETE' }); loadLibrary(); } catch (e) { toast(e.message); } }
$('#clearAll').onclick = async () => {
  if (!confirm('Limpar todo o histórico e apagar os arquivos disponíveis?')) return;
  try { await api('/api/library', { method: 'DELETE' }); loadLibrary(); } catch (e) { toast(e.message); }
};

// ---------- Inicialização ----------
(async function init() {
  applySettings(); loadLibrary();
  const b = $('#banner');
  try {
    cfg = await api('/api/config');
    $('#limits').textContent = `Até ${cfg.maxUploadMB} MB e ${cfg.maxDurationMin} min. Use apenas mídias que seja seu ou tenha licença para converter.`;
    const msgs = [];
    if (!cfg.ffmpeg) msgs.push('FFmpeg não está configurado no servidor: a conversão está indisponível até que seja instalado.');
    if (msgs.length) { b.textContent = msgs.join(' '); b.hidden = false; }
  } catch (err) { b.textContent = err.message; b.hidden = false; }
})();
setInterval(() => { if (!document.hidden && !activeJob) loadLibrary(); }, 15000);
