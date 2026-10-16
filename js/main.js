/**
 * main.js — Interfaz: selección de archivos, mezclador por canal y exportación.
 */

import {
  decodeAudioFile, computePeaks, resampleChannels, playbackContext, ChannelMonitor,
} from './audio-engine.js';
import { getFFmpeg, encodeWithFFmpeg, isEngineAvailable } from './ffmpeg.js';
import { encodeWav } from './wav-encoder.js';
import { makeZip } from './zip.js';
import { defaultLayoutFor, layoutsForCount, channelColor } from './channel-layouts.js';
import {
  fmtBytes, fmtTime, fmtDb, clamp, sanitizeFilename, stripExtension, extensionOf,
  applyNameTemplate, downloadBlob, sleep, mixChannels, normalizeIfClipping,
} from './utils.js';

/* ═══════════════════════════════ estado ═══════════════════════════════ */

const OUTPUT_FORMATS = [
  { id: 'wav24', ext: 'wav', label: 'WAV · 24 bits PCM', native: true, bitDepth: 24 },
  { id: 'wav16', ext: 'wav', label: 'WAV · 16 bits PCM', native: true, bitDepth: 16 },
  { id: 'wav32', ext: 'wav', label: 'WAV · 32 bits float', native: true, bitDepth: 32 },
  { id: 'flac', ext: 'flac', label: 'FLAC · sin pérdida', native: false, codecArgs: ['-c:a', 'flac', '-compression_level', '5'] },
  { id: 'mp3', ext: 'mp3', label: 'MP3 · 320 kbps', native: false, codecArgs: ['-c:a', 'libmp3lame', '-b:a', '320k'] },
  { id: 'mp3v', ext: 'mp3', label: 'MP3 · 192 kbps', native: false, codecArgs: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
  { id: 'opus', ext: 'opus', label: 'Opus · 192 kbps', native: false, codecArgs: ['-c:a', 'libopus', '-b:a', '192k', '-vbr', 'on'] },
  { id: 'm4a', ext: 'm4a', label: 'AAC · M4A 256 kbps', native: false, codecArgs: ['-c:a', 'aac', '-b:a', '256k'] },
  { id: 'aac', ext: 'aac', label: 'AAC · ADTS 256 kbps', native: false, codecArgs: ['-c:a', 'aac', '-b:a', '256k'] },
  { id: 'eac3', ext: 'eac3', label: 'E-AC3 · 640 kbps', native: false, codecArgs: ['-c:a', 'eac3', '-b:a', '640k'] },
  { id: 'ac3', ext: 'ac3', label: 'AC-3 · 448 kbps', native: false, codecArgs: ['-c:a', 'ac3', '-b:a', '448k'] },
];

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 8000];

const state = {
  /** @type {{id:number, file:File, name:string, status:string, info?:object, error?:string}[]} */
  tracks: [],
  currentId: null,
  /** @type {AudioBuffer|null} */
  buffer: null,
  /** @type {import('./audio-engine.js').ChannelMonitor|null} */
  monitor: null,
  layout: null,
  peaks: null,
  /** Canales marcados para crear grupos */
  selection: new Set(),
  /** @type {{name:string, channels:number[]}[]} */
  groups: [],
  results: [],          // {name, blob, size}
  zip: null,            // {name, blob}
  controller: null,     // AbortController de la tarea en curso
  nextTrackId: 1,
};

/* ═══════════════════════════════ DOM ═══════════════════════════════ */

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('fileInput'), pickBtn: $('pickBtn'),
  trackList: $('trackList'), trackCount: $('trackCount'), trackListWrap: $('trackListWrap'),
  clearTracks: $('clearTracks'),
  infoPanel: $('infoPanel'), mixPanel: $('mixPanel'), expPanel: $('expPanel'),
  mName: $('mName'), mDuration: $('mDuration'), mRate: $('mRate'),
  mChannels: $('mChannels'), mSize: $('mSize'), mDepth: $('mDepth'),
  engineTag: $('engineTag'), layoutSelect: $('layoutSelect'), layoutHint: $('layoutHint'),
  playBtn: $('playBtn'), stopBtn: $('stopBtn'), seek: $('seek'), tCur: $('tCur'), tDur: $('tDur'),
  loopChk: $('loopChk'), masterGain: $('masterGain'), masterGainOut: $('masterGainOut'),
  soloNone: $('soloNone'), chStrip: $('chStrip'), playHint: $('playHint'),
  fmtSelect: $('fmtSelect'), rateSelect: $('rateSelect'), numSelect: $('numSelect'),
  nameTpl: $('nameTpl'), scopeSelect: $('scopeSelect'), zipChk: $('zipChk'),
  ditherChk: $('ditherChk'), limiterChk: $('limiterChk'),
  groupList: $('groupList'), groupCount: $('groupCount'), groupName: $('groupName'),
  addGroup: $('addGroup'), clearGroups: $('clearGroups'), groupMode: $('groupMode'),
  exportBtn: $('exportBtn'), exportPreview: $('exportPreview'),
  downloadAllBtn: $('downloadAllBtn'), resultsWrap: $('resultsWrap'),
  resultsList: $('resultsList'), resultsToggle: $('resultsToggle'),
  busy: $('busy'), busyLabel: $('busyLabel'), busySub: $('busySub'), bar: $('bar'),
  cancelBtn: $('cancelBtn'), closeBusy: $('closeBusy'),
  toasts: $('toasts'), themeToggle: $('themeToggle'), engineBadge: $('engineBadge'),
};

/* ═══════════════════════════ utilidades UI ═══════════════════════════ */

function toast(message, kind = 'info', ms = 5200) {
  const icons = {
    ok: '<path d="m4 12.5 4.5 4.5L20 6"/>',
    err: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6h.01"/>',
  };
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<svg class="toast-ico" viewBox="0 0 24 24">${icons[kind] ?? icons.info}</svg>
    <div class="toast-body"></div>
    <button class="toast-x" aria-label="Cerrar"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>`;
  node.querySelector('.toast-body').textContent = message;
  const close = () => node.remove();
  node.querySelector('.toast-x').addEventListener('click', close);
  el.toasts.appendChild(node);
  if (ms) setTimeout(close, ms);
  return node;
}

function busy(label, { cancellable = false } = {}) {
  el.busy.hidden = false;
  el.busyLabel.textContent = label;
  el.busySub.textContent = '';
  el.bar.style.width = '0%';
  el.cancelBtn.hidden = !cancellable;
  el.closeBusy.hidden = true;
  el.busy.setAttribute('aria-busy', 'true');
}

function busyProgress(frac, sub) {
  el.bar.style.width = `${clamp(frac * 100, 0, 100).toFixed(1)}%`;
  if (sub != null) el.busySub.textContent = sub;
}

function busyDone(message = '¡Listo!') {
  el.busyLabel.textContent = message;
  el.busySub.textContent = '';
  el.bar.style.width = '100%';
  el.cancelBtn.hidden = true;
  el.closeBusy.hidden = false;
  el.busy.removeAttribute('aria-busy');
}

function busyHide() {
  el.busy.hidden = true;
  state.controller = null;
}

el.cancelBtn.addEventListener('click', () => {
  state.controller?.abort();
  el.busySub.textContent = 'Cancelando…';
});
el.closeBusy.addEventListener('click', busyHide);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Convierte un error técnico en un mensaje que pueda leer una persona, sin
 * destapar detalles internos (nombres de librerías, registros del motor…).
 */
function friendlyError(err) {
  const msg = String(err?.message ?? err ?? '');
  if (/ffmpeg|wasi|wasm|Worker|transcod|terminó con código/i.test(msg)) {
    return 'No se pudo procesar el audio. Prueba a convertirlo a WAV o FLAC y vuelve a intentarlo.';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return 'Falta conexión a internet. Necesario solo para formatos comprimidos; el WAV no lo requiere.';
  }
  if (/memory|out of range|allocation/i.test(msg)) {
    return 'No hay memoria suficiente en la pestaña para este archivo. Prueba con uno más corto.';
  }
  if (/NotSupportedError|decodeAudioData|unsupported/i.test(msg)) {
    return 'El navegador no sabe abrir este formato de audio.';
  }
  return (msg.split('\n')[0] || 'Error desconocido').slice(0, 140);
}

/* ═══════════════════════ 1. Carga de archivos ═══════════════════════ */

el.pickBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  el.fileInput.click();
});
el.dropzone.addEventListener('click', (e) => {
  if (e.target.closest('#pickBtn')) return;
  el.fileInput.click();
});
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', () => {
  addFiles([...el.fileInput.files]);
  el.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((type) =>
  el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((type) =>
  el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.remove('drag'); }));
el.dropzone.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  addFiles(files);
});

// Evitar que soltar un archivo fuera del dropzone haga navegar la página.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function addFiles(files) {
  const audio = files.filter((f) => f.size > 0);
  const rejected = files.filter((f) => f.size === 0);
  if (!audio.length) {
    if (rejected.length) toast('Los archivos están vacíos.', 'err');
    return;
  }
  for (const file of audio) {
    const track = { id: state.nextTrackId++, file, name: file.name, status: 'esperando', info: null, error: null };
    state.tracks.push(track);
    void openTrack(track, state.tracks.length === 1);
  }
  if (rejected.length) toast(`${rejected.length} archivo(s) vacío(s) ignorados.`, 'err');
  renderTracks();
}

function renderTracks() {
  el.trackListWrap.hidden = state.tracks.length === 0;
  el.dropzone.classList.toggle('compact', state.tracks.length > 0);
  el.trackCount.textContent = state.tracks.length;
  el.trackList.innerHTML = '';
  for (const t of state.tracks) {
    const li = document.createElement('li');
    li.className = `track${t.id === state.currentId ? ' active' : ''}`;
    li.tabIndex = 0;
    const sub = t.status === 'error'
      ? `<span class="err">${esc(t.error ?? 'Error')}</span>`
      : t.info
        ? `${esc(t.info.container)}${t.info.codec ? ` · ${esc(t.info.codec)}` : ''} · ${t.info.sampleRate ? `${t.info.sampleRate / 1000} kHz` : '—'} · ${t.info.channels} can.`
        : '<span>Abriendo…</span>';
    li.innerHTML = `
      <span class="track-ico"><svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg></span>
      <span class="track-body">
        <span class="track-name">${esc(t.name)}</span>
        <span class="track-sub">${fmtBytes(t.file.size)} · ${sub}</span>
      </span>
      <button class="track-del" aria-label="Quitar"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>`;
    li.querySelector('.track-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeTrack(t.id);
    });
    const open = () => openTrack(t, true);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    el.trackList.appendChild(li);
  }
}

function removeTrack(id) {
  const idx = state.tracks.findIndex((t) => t.id === id);
  if (idx < 0) return;
  if (state.tracks[idx].id === state.currentId) {
    state.monitor?.dispose();
    state.monitor = null;
    state.currentId = null;
    renderWorkspace();
  }
  state.tracks.splice(idx, 1);
  if (!state.tracks.length) clearResults();
  renderTracks();
}

el.clearTracks.addEventListener('click', () => {
  state.monitor?.dispose();
  state.monitor = null;
  state.tracks = [];
  state.currentId = null;
  state.selection.clear();
  renderTracks();
  renderWorkspace();
  clearResults();
});

/* ═══════════════════════ 2. Decodificación ═══════════════════════ */

async function openTrack(track, makeCurrent = true) {
  if (state.currentId === track.id && state.monitor) return;
  if (track.status === 'error' && !track.file.size) return;

  track.status = 'decodificando';
  if (makeCurrent) {
    state.currentId = track.id;
    renderTracks();
  }
  if (makeCurrent) busy('Abriendo archivo…');

  try {
    const { buffer, probe, engine } = await decodeAudioFile(track.file, {
      onStage: (msg, frac) => makeCurrent && busyProgress(frac, `${track.name} — ${msg}`),
      onWarn: (msg) => toast(msg, 'err', 12000),
    });

    track.status = 'listo';
    track.info = {
      ...probe, engine, sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels, duration: buffer.duration,
    };

    if (makeCurrent) {
      state.monitor?.dispose();
      state.monitor = null;
      state.buffer = buffer;
      state.layout = pickLayout(buffer.numberOfChannels, probe);
      state.peaks = computePeaks(buffer);
      state.selection.clear();
      state.groups = [];
      state.monitor = new ChannelMonitor(buffer, state.layout);
      state.monitor.onEnded = () => syncTransport();
      buildWorkspace();
      busyHide();
      renderTracks();
    }
  } catch (err) {
    console.error(err);
    track.status = 'error';
    track.error = friendlyError(err);
    if (makeCurrent) {
      busyDone('No se pudo abrir el archivo');
      setTimeout(busyHide, 2600);
      toast(`No se pudo abrir «${track.name}»: ${track.error}`, 'err', 9000);
    }
    renderTracks();
  }
}

/** Elige la distribución más plausible: la del contenedor si la conocemos. */
function pickLayout(channels, probe) {
  const detected = channelLayoutFromProbe(probe, channels);
  const candidates = layoutsForCount(channels);
  if (detected && candidates.some((c) => c.id === detected)) return candidates.find((c) => c.id === detected);
  return defaultLayoutFor(channels);
}

/** Traduce el nombre del contenedor a nuestro id de distribución. */
function channelLayoutFromProbe(probe, channels) {
  const text = `${probe.container ?? ''} ${probe.codec ?? ''}`.toLowerCase();
  if (channels === 6 && text.includes('side')) return '5.1';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  if (channels === 2) return 'stereo';
  return null;
}

function buildWorkspace() {
  const b = state.buffer;
  const t = state.tracks.find((x) => x.id === state.currentId);
  const info = t?.info ?? {};

  el.mName.textContent = t?.name ?? '—';
  el.mDuration.textContent = fmtTime(b.duration);
  el.mRate.innerHTML = `${(b.sampleRate / 1000).toFixed(3).replace('.', ',')} <small>kHz</small>`;
  el.mChannels.textContent = `${b.numberOfChannels} canales`;
  el.mSize.innerHTML = `${fmtBytes(t?.file.size ?? 0)} <small>· ${fmtTime(b.duration)}</small>`;
  el.mDepth.innerHTML = info.bitDepth
    ? `${info.bitDepth} <small>bits</small>`
    : '—';

  el.engineTag.textContent = [info.codec || info.container, info.sampleRate ? `${info.sampleRate / 1000} kHz` : null]
    .filter(Boolean).join(' · ') || 'audio';
  el.engineTag.className = 'badge';

  // Distribución de canales
  el.layoutSelect.innerHTML = '';
  const candidates = layoutsForCount(b.numberOfChannels);
  if (!candidates.some((c) => c.id === state.layout.id)) candidates.unshift(state.layout);
  for (const layout of candidates) {
    const opt = document.createElement('option');
    opt.value = layout.id;
    opt.textContent = layout.name;
    opt.selected = layout.id === state.layout.id;
    el.layoutSelect.appendChild(opt);
  }
  el.layoutHint.textContent = candidates.length > 1
    ? 'Si los nombres no coinciden con tu archivo, prueba la otra distribución.'
    : 'Los nombres siguen el orden de canales del archivo.';

  // El monitor ajusta la salida para que la suma de N canales no sature:
  // reflejamos ese valor en el control para que no haya sorpresas.
  el.masterGain.value = String(Math.round(state.monitor.defaultMasterGain * 100));
  el.masterGainOut.textContent = fmtDb(state.monitor.defaultMasterGain);

  buildRateOptions();
  buildChannelStrip();
  renderGroups();
  updateExportPreview();
  syncTransport();
  renderWorkspace();
}

function renderWorkspace() {
  const has = Boolean(state.monitor);
  el.infoPanel.hidden = !has;
  el.mixPanel.hidden = !has;
  el.expPanel.hidden = !has;
}

el.layoutSelect.addEventListener('change', () => {
  const found = layoutsForCount(state.buffer.numberOfChannels).find((l) => l.id === el.layoutSelect.value);
  if (!found) return;
  state.layout = found;
  state.monitor?.setLayout(state.layout);
  buildChannelStrip();
  renderGroups();
});

function buildRateOptions() {
  const native = state.buffer.sampleRate;
  el.rateSelect.innerHTML = '';
  const add = (value, label) => {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = label;
    el.rateSelect.appendChild(opt);
  };
  add(native, `Original (${(native / 1000).toFixed(3).replace('.', ',')} kHz)`);
  for (const rate of SAMPLE_RATES) {
    if (rate === native) continue;
    add(rate, rate >= 1000 ? `${(rate / 1000).toFixed(3).replace('.', ',')} kHz` : `${rate} Hz`);
  }
  el.rateSelect.value = String(native);
}

/* ═══════════════════════ 3. Mezclador por canal ═══════════════════════ */

function buildChannelStrip() {
  const b = state.buffer;
  el.chStrip.innerHTML = '';
  const heads = { min: [], max: [] };

  for (let i = 0; i < b.numberOfChannels; i++) {
    const meta = state.layout.channels[i] ?? { code: `CH${i + 1}`, name: `Canal ${i + 1}`, short: `Canal ${i + 1}` };
    const color = channelColor(i);

    const row = document.createElement('div');
    row.className = 'ch';
    row.dataset.index = String(i);
    row.innerHTML = `
      <div class="ch-name">
        <span class="ch-dot" style="background:${color}"></span>
        <span class="ch-labels">
          <span class="ch-tag">${esc(meta.code)}</span>
          <span class="ch-desc">${esc(meta.lfe ? 'Graves (LFE)' : meta.name)}</span>
        </span>
        <input class="ch-pick" type="checkbox" title="Marcar para crear un grupo" ${state.selection.has(i) ? 'checked' : ''}>
      </div>
      <div class="ch-wave" title="Haz clic para saltar aquí">
        <canvas></canvas>
        <div class="ch-playhead" style="left:0"></div>
      </div>
      <div class="ch-meter">
        <div class="meter"><div class="meter-fill" style="background:${color}"></div><div class="meter-peak"></div></div>
        <span class="meter-db">-∞</span>
      </div>
      <div class="ch-acts">
        <button class="tog solo" title="Escuchar solo este canal">S</button>
        <button class="tog mute" title="Silenciar este canal">M</button>
        <button class="tog dl" title="Descargar este canal ahora">
          <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        </button>
      </div>`;

    const canvas = row.querySelector('canvas');
    requestAnimationFrame(() => drawWave(canvas, i));
    heads.min.push(state.peaks.min[i]);
    heads.max.push(state.peaks.max[i]);

    const soloBtn = row.querySelector('.solo');
    const muteBtn = row.querySelector('.mute');
    soloBtn.addEventListener('click', () => setSolo(state.monitor.soloIndex === i ? null : i));
    muteBtn.addEventListener('click', () => {
      const muted = !state.monitor.muted.has(i);
      state.monitor.setMuted(i, muted);
      muteBtn.classList.toggle('on', muted);
      row.classList.toggle('muted', muted);
    });

    const pick = row.querySelector('.ch-pick');
    pick.addEventListener('change', () => {
      if (pick.checked) state.selection.add(i); else state.selection.delete(i);
      renderGroups();
    });

    row.querySelector('.ch-wave').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      state.monitor.seek(ratio * state.buffer.duration);
      if (!state.monitor.playing) state.monitor.play(ratio * state.buffer.duration);
      syncTransport();
    });

    row.querySelector('.dl').addEventListener('click', () => quickDownloadChannel(i));
    el.chStrip.appendChild(row);
  }

  applySoloState();
  el.playHint.textContent = state.buffer.numberOfChannels > 2
    ? 'Escucha espacial: el centro y el LFE suenan en los dos lados, el canal izquierdo solo a la izquierda y el derecho (y los surrounds) solo a la derecha. Aísla con «S» para comprobar cada canal.'
    : 'Pulsa espacio para reproducir y haz clic en la forma de onda para saltar de sitio.';
}

function drawWave(canvas, index) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { min, max, buckets } = state.peaks;
  const color = channelColor(index);
  const mid = h / 2;
  const scale = mid * 0.92;

  // fondo: línea central
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();

  const perPixel = buckets / w;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  for (let x = 0; x < w; x++) {
    const from = Math.floor(x * perPixel);
    const to = Math.max(from + 1, Math.floor((x + 1) * perPixel));
    let lo = 1, hi = -1;
    for (let k = from; k < to && k < buckets; k++) {
      if (min[index][k] < lo) lo = min[index][k];
      if (max[index][k] > hi) hi = max[index][k];
    }
    const y1 = mid - hi * scale;
    const y2 = mid - lo * scale;
    ctx.fillRect(x, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
  }
  ctx.globalAlpha = 1;
}

let redrawTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    if (!state.peaks) return;
    el.chStrip.querySelectorAll('.ch').forEach((row) => drawWave(row.querySelector('canvas'), Number(row.dataset.index)));
  }, 180);
});

function setSolo(index) {
  state.monitor?.setSolo(index);
  applySoloState();
}

function applySoloState() {
  const solo = state.monitor?.soloIndex ?? null;
  el.chStrip.querySelectorAll('.ch').forEach((row) => {
    const i = Number(row.dataset.index);
    row.classList.toggle('soloed', solo === i);
    row.querySelector('.solo').classList.toggle('on', solo === i);
  });
}

el.soloNone.addEventListener('click', () => setSolo(null));

/* ── transporte ── */

el.playBtn.addEventListener('click', togglePlay);
el.stopBtn.addEventListener('click', () => {
  state.monitor?.stop();
  syncTransport();
});

function togglePlay() {
  const m = state.monitor;
  if (!m) return;
  playbackContext(); // reanuda el contexto tras el gesto del usuario
  if (m.playing) m.pause();
  else m.play(m.currentTime >= m.duration - 0.01 ? 0 : m.currentTime);
  syncTransport();
}

el.seek.addEventListener('input', () => {
  if (!state.monitor) return;
  state.monitor.seek((Number(el.seek.value) / 1000) * state.buffer.duration);
  syncTransport();
});
el.loopChk.addEventListener('change', () => state.monitor?.setLoop(el.loopChk.checked));
el.masterGain.addEventListener('input', () => {
  const v = Number(el.masterGain.value) / 100;
  state.monitor?.setMasterGain(v);
  el.masterGainOut.textContent = fmtDb(v);
});

function syncTransport() {
  const m = state.monitor;
  if (!m) return;
  el.playBtn.querySelector('.ico-play').hidden = m.playing;
  el.playBtn.querySelector('.ico-pause').hidden = !m.playing;
  el.playBtn.setAttribute('aria-label', m.playing ? 'Pausar' : 'Reproducir');
  el.tDur.textContent = fmtTime(m.duration);
  el.tCur.textContent = fmtTime(m.currentTime);
  el.seek.value = String(Math.round((m.currentTime / m.duration) * 1000));
}

/* Bucle de animación: vúmetros, cabezal de reproducción y tiempo. */
let lastMeterUpdate = 0;
function frame(now) {
  const m = state.monitor;
  if (m) {
    if (now - lastMeterUpdate > 50) {
      lastMeterUpdate = now;
      const levels = m.levels();
      el.chStrip.querySelectorAll('.ch').forEach((row, i) => {
        const lin = levels[i] ?? 0;
        const db = 20 * Math.log10(Math.max(lin, 1e-6));
        const pct = clamp((db + 60) / 60, 0, 1) * 100;
        row.querySelector('.meter-fill').style.width = `${pct}%`;
        row.querySelector('.meter-db').textContent = db <= -59 ? '-∞' : `${db.toFixed(0)} dB`;
      });
    }
    const ratio = m.duration ? m.currentTime / m.duration : 0;
    const pct = `${(ratio * 100).toFixed(3)}%`;
    el.chStrip.querySelectorAll('.ch-playhead').forEach((ph) => { ph.style.left = pct; });
    if (m.playing && now - lastMeterUpdate > 90) syncTransport();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ═══════════════════════ 4. Grupos ═══════════════════════ */

el.addGroup.addEventListener('click', addGroup);
el.groupName.addEventListener('keydown', (e) => { if (e.key === 'Enter') addGroup(); });

function addGroup() {
  const chosen = [...state.selection].sort((a, b) => a - b);
  if (!chosen.length) {
    toast('Marca primero algún canal con la casilla de selección.', 'err');
    return;
  }
  const name = sanitizeFilename(el.groupName.value.trim() || defaultGroupName(chosen), 60);
  if (state.groups.some((g) => g.name === name)) {
    toast('Ya existe un grupo con ese nombre.', 'err');
    return;
  }
  state.groups.push({ name, channels: chosen });
  el.groupName.value = '';
  renderGroups();
  updateExportPreview();
}

function defaultGroupName(chosen) {
  const codes = chosen.map((i) => state.layout.channels[i]?.code ?? i).join('-');
  return `grupo_${codes}`;
}

function renderGroups() {
  el.groupCount.textContent = state.groups.length;
  if (!state.groups.length) {
    el.groupList.innerHTML = '<p class="empty">Sin grupos. Marca canales arriba con la casilla y pulsa «Crear con la selección».</p>';
    return;
  }
  el.groupList.innerHTML = '';
  for (const [idx, g] of state.groups.entries()) {
    const div = document.createElement('div');
    div.className = 'group';
    div.innerHTML = `<span class="group-name">${esc(g.name)}</span>
      <span class="group-chs"></span>
      <button class="group-x" aria-label="Quitar grupo"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>`;
    const box = div.querySelector('.group-chs');
    for (const c of g.channels) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.style.borderColor = `${channelColor(c)}66`;
      tag.textContent = state.layout.channels[c]?.code ?? `CH${c + 1}`;
      box.appendChild(tag);
    }
    div.querySelector('.group-x').addEventListener('click', () => {
      state.groups.splice(idx, 1);
      renderGroups();
      updateExportPreview();
    });
    el.groupList.appendChild(div);
  }
}

el.clearGroups.addEventListener('click', () => {
  state.groups = [];
  renderGroups();
  updateExportPreview();
});

/* ═══════════════════════ 5. Exportación ═══════════════════════ */

for (const fmt of OUTPUT_FORMATS) {
  const opt = document.createElement('option');
  opt.value = fmt.id;
  opt.textContent = fmt.label;
  opt.dataset.native = fmt.native ? '1' : '0';
  el.fmtSelect.appendChild(opt);
}
el.fmtSelect.value = 'wav24';

el.fmtSelect.addEventListener('change', updateExportPreview);
el.rateSelect.addEventListener('change', updateExportPreview);
el.scopeSelect.addEventListener('change', updateExportPreview);
el.groupMode.addEventListener('change', updateExportPreview);
el.numSelect.addEventListener('change', updateExportPreview);

/** Frecuencia elegida; si el selector quedó sin valor, la original. */
function selectedRate(buffer) {
  const value = Number(el.rateSelect.value);
  return Number.isFinite(value) && value > 0 ? value : buffer.sampleRate;
}

function currentFormat() {
  return OUTPUT_FORMATS.find((f) => f.id === el.fmtSelect.value) ?? OUTPUT_FORMATS[0];
}

function tracksInScope() {
  if (el.scopeSelect.value === 'all') {
    return state.tracks.filter((t) => t.status === 'listo');
  }
  const t = state.tracks.find((x) => x.id === state.currentId);
  return t && t.status === 'listo' ? [t] : [];
}

function updateExportPreview() {
  const fmt = currentFormat();
  const tracks = tracksInScope();
  const files = tracks.reduce((acc, t) => acc + (t.info?.channels ?? 0) + state.groups.length, 0);
  const bits = [];
  bits.push(`${files} archivo${files === 1 ? '' : 's'}`);
  if (state.groups.length) bits.push(`${state.groups.length} grupo${state.groups.length === 1 ? '' : 's'}`);
  bits.push(el.zipChk.checked ? '1 ZIP' : 'descargas sueltas');
  el.exportPreview.textContent = tracks.length ? bits.join(' · ') : 'No hay archivos listos para exportar.';
  el.exportBtn.disabled = !tracks.length;
}

el.zipChk.addEventListener('change', updateExportPreview);

el.exportBtn.addEventListener('click', () => runExport());
el.downloadAllBtn.addEventListener('click', () => {
  if (state.zip) downloadBlob(state.zip.blob, state.zip.name);
  else downloadResults();
});

async function runExport() {
  const tracks = tracksInScope();
  if (!tracks.length) return;

  const fmt = currentFormat();
  const controller = new AbortController();
  state.controller = controller;
  const signal = controller.signal;

  busy(`Exportando ${tracks.length} archivo(s)…`, { cancellable: true });
  const results = [];
  clearResults(); // si el trabajo falla, no dejamos una lista vieja en pantalla
  const totalUnits = tracks.reduce((acc, t) => acc + t.info.channels + state.groups.length, 0);
  let done = 0;
  const started = performance.now();

  try {
    for (const track of tracks) {
      if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
      busyProgress(0, `${track.name}`);

      const buffer = await ensureBuffer(track, signal);
      const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => new Float32Array(buffer.getChannelData(c)));
      const targetRate = selectedRate(buffer);
      const rate = await resampleChannels(chans, buffer.sampleRate, targetRate);

      const numbering = Number(el.numSelect.value);
      const base = sanitizeFilename(stripExtension(track.name));
      const layout = pickLayout(buffer.numberOfChannels, track.info ?? {});

      // 5.a Un archivo por canal
      for (let c = 0; c < rate.length; c++) {
        if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        const data = [rate[c]];
        const filename = buildName({
          base, chIndex: c + numbering, chMeta: layout.channels[c],
          ext: fmt.ext, rate: targetRate, layout,
        });
        results.push(await emit(filename, data, targetRate, fmt, signal, done / totalUnits));
        done++;
        busyProgress(done / totalUnits, `${filename}`);
      }

      // 5.b Grupos de canales
      const mode = el.groupMode.value;
      for (const group of state.groups) {
        if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        const picked = group.channels.filter((c) => c < rate.length).map((c) => rate[c]);
        if (!picked.length) continue;
        const data = mode === 'mix' ? [mixChannels(picked)] : picked;
        const filename = buildName({
          base, chIndex: null, chMeta: { code: group.name, name: group.name },
          ext: fmt.ext, rate: targetRate, layout,
        });
        results.push(await emit(filename, data, targetRate, fmt, signal, done / totalUnits));
        done++;
        busyProgress(done / totalUnits, `${filename}`);
      }
    }

    state.results = results;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    if (el.zipChk.checked) {
      busyProgress(1, 'Comprimiendo…');
      const zipName = `${sanitizeFilename(tracks.length === 1 ? stripExtension(tracks[0].name) : 'canales')}_${stamp()}.zip`;
      const { blob } = await makeZip(results.map((r) => ({ name: r.name, data: r.blob })), {
        signal,
        onProgress: (a, b) => busyProgress(1, `Comprimiendo ${a}/${b}…`),
      });
      state.zip = { name: zipName, blob };
      el.downloadAllBtn.textContent = `Descargar ${zipName}`;
      downloadBlob(blob, zipName);
      busyDone(`${results.length} archivo(s) → ${zipName} (${fmtBytes(blob.size)}) · ${seconds} s`);
    } else {
      state.zip = null;
      el.downloadAllBtn.textContent = 'Descargar todo';
      busyDone(`${results.length} archivo(s) en ${seconds} s`);
      await downloadResults(results, signal);
    }

    renderResults();
    el.downloadAllBtn.hidden = false;
    toast(`Exportación completada: ${results.length} archivo(s).`, 'ok');
  } catch (err) {
    if (err?.name === 'AbortError') {
      toast('Exportación cancelada.', 'info');
      busyHide();
    } else {
      console.error(err);
      toast(`Error al exportar: ${friendlyError(err)}`, 'err', 10000);
      busyDone('Error al exportar');
    }
  } finally {
    state.controller = null;
  }
}

/** Devuelve el AudioBuffer del track, decodificándolo si hace falta. */
async function ensureBuffer(track, signal) {
  if (state.currentId === track.id && state.buffer) return state.buffer;
  const { buffer } = await decodeAudioFile(track.file, {
    onStage: (msg) => busySub(msg),
    onWarn: (msg) => toast(msg, 'err', 12000),
  });
  track.info = { ...track.info, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, duration: buffer.duration };
  if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
  return buffer;
}

const busySub = (msg) => { el.busySub.textContent = msg; };

/** Codifica un canal (o grupo) y devuelve {name, blob}. */
async function emit(filename, channels, sampleRate, fmt, signal, frac) {
  let data = channels.map((c) => Float32Array.from(c)); // copia: el normalizador modifica
  let blob;

  if (el.limiterChk.checked) normalizeIfClipping(data, -0.3);

  if (fmt.native) {
    const useDither = fmt.bitDepth === 16 && el.ditherChk.checked;
    await sleep(0); // deja pintar la barra de progreso
    blob = encodeWav(data, sampleRate, { bitDepth: fmt.bitDepth, dither: useDither });
  } else {
    busySub(`${filename} — convirtiendo…`);
    const wav = encodeWav(data, sampleRate, { bitDepth: 24 });
    const bytes = await encodeWithFFmpeg(await wav.arrayBuffer(), fmt, {
      signal,
      onProgress: (p) => busyProgress(frac * 0.9 + p * 0.1, `${filename} — ${(p * 100).toFixed(0)} %`),
    });
    blob = new Blob([bytes], { type: 'audio/mpeg' });
  }

  return { name: filename, blob, size: blob.size };
}

function buildName({ base, chIndex, chMeta, ext, rate, layout }) {
  const tpl = el.nameTpl.value.trim() || '{name}_{chn}_{ch}.{ext}';
  const name = sanitizeFilename(applyNameTemplate(tpl, {
    name: base,
    ch: chIndex ?? 'x',
    chn: chMeta?.code ?? 'grupo',
    chname: sanitizeFilename(chMeta?.name ?? '', 40),
    layout: layout?.id ?? state.layout?.id ?? '',
    sr: rate,
    ext,
  }), 140);
  // Garantiza la extensión correcta aunque el patrón no la incluya.
  return extensionOf(name) === ext ? name : `${name}.${ext}`;
}

function renderResults() {
  el.resultsWrap.hidden = state.results.length === 0;
  el.resultsList.innerHTML = '';
  for (const r of state.results) {
    const li = document.createElement('li');
    li.className = 'result';
    li.innerHTML = `<span class="result-name"></span><span class="result-size">${fmtBytes(r.size)}</span>`;
    li.querySelector('.result-name').textContent = r.name;
    const a = document.createElement('a');
    a.className = 'result-dl';
    a.href = '#';
    a.textContent = 'Descargar';
    a.addEventListener('click', (e) => { e.preventDefault(); downloadBlob(r.blob, r.name); });
    li.appendChild(a);
    el.resultsList.appendChild(li);
  }
}

el.resultsToggle.addEventListener('click', () => {
  const open = el.resultsList.style.display !== 'none';
  el.resultsList.style.display = open ? 'none' : 'flex';
  el.resultsToggle.textContent = open ? 'Mostrar' : 'Contraer';
});

function clearResults() {
  state.results = [];
  state.zip = null;
  el.resultsWrap.hidden = true;
  el.downloadAllBtn.hidden = true;
}

async function downloadResults(list = state.results, signal) {
  const items = list ?? [];
  for (const [i, r] of items.entries()) {
    if (signal?.aborted) break;
    downloadBlob(r.blob, r.name);
    if (i < items.length - 1) await sleep(260); // evita que el navegador bloquee las descargas
  }
}

/** Descarga inmediata de un canal suelto con los ajustes de salida actuales. */
async function quickDownloadChannel(index) {
  const track = state.tracks.find((t) => t.id === state.currentId);
  if (!track) return;
  const fmt = currentFormat();
  const controller = new AbortController();
  busy(`Guardando canal ${index}…`, { cancellable: true });
  try {
    const chans = [new Float32Array(state.buffer.getChannelData(index))];
    const rate = selectedRate(state.buffer);
    const resampled = await resampleChannels(chans, state.buffer.sampleRate, rate);
    const numbering = Number(el.numSelect.value);
    const meta = state.layout.channels[index];
    const filename = buildName({
      base: sanitizeFilename(stripExtension(track.name)),
      chIndex: index + numbering,
      chMeta: meta,
      ext: fmt.ext,
      rate,
    });
    const { blob } = await emit(filename, resampled, rate, fmt, controller.signal, 0.5);
    downloadBlob(blob, filename);
    busyDone(`${filename} · ${fmtBytes(blob.size)}`);
    setTimeout(busyHide, 1500);
  } catch (err) {
    console.error(err);
    const extra = !isEngineAvailable() && !fmt.native
      ? ' Los formatos comprimidos requieren descargar un componente adicional; el WAV no lo necesita.'
      : '';
    toast(`No se pudo guardar: ${friendlyError(err)}.${extra}`, 'err', 10000);
    busyHide();
  }
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/* ═══════════════════════ 6. Atajos de teclado ═══════════════════════ */

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!state.monitor) return;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if (e.key >= '0' && e.key <= '9') {
    const n = Number(e.key);
    if (n === 0) setSolo(null);
    else if (n <= state.buffer.numberOfChannels) setSolo(n - 1);
    return;
  }
  if (e.key === 'Escape') setSolo(null);
  if (e.key === 'ArrowLeft') state.monitor.seek(Math.max(0, state.monitor.currentTime - 5));
  if (e.key === 'ArrowRight') state.monitor.seek(Math.min(state.monitor.duration, state.monitor.currentTime + 5));
});

/* ═══════════════════════ 7. Tema ═══════════════════════ */

const savedTheme = localStorage.getItem('divisor-tema');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
el.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('divisor-tema', next);
});

/* ═══════════════════════ 8. Arranque ═══════════════════════ */

// Comprobación temprana de capacidades del navegador.
(function checkSupport() {
  const missing = [];
  if (!globalThis.AudioContext && !globalThis.webkitAudioContext) missing.push('Web Audio API');
  if (typeof globalThis.CompressionStream !== 'function') missing.push('CompressionStream (ZIP sin compresión)');
  if (missing.length) {
    toast(`Tu navegador no soporta: ${missing.join(', ')}. Usa una versión reciente de Chrome, Edge, Firefox o Safari.`, 'err', 15000);
  }
  if (!globalThis.isSecureContext) {
    el.engineBadge.textContent = 'contexto local';
  }
})();

// Precarga silenciosa del motor de conversión en segundo plano: si más tarde hace
// falta (E-AC3, DTS…) ya está en memoria. Si falla, la app sigue con WAV y no se
// molesta al usuario: el aviso aparece solo si luego realmente se necesita.
if ('requestIdleCallback' in window) {
  requestIdleCallback(() => { getFFmpeg(() => {}).catch(() => { /* seguirá funcionando con WAV */ }); }, { timeout: 8000 });
}

updateExportPreview();

// Expuesto para pruebas automatizadas en el navegador.
globalThis.__divisor = { state, OUTPUT_FORMATS, setSolo, runExport, emit, buildName, addFiles, openTrack };