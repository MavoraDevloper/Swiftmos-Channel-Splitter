/**
 * utils.js — pequeñas utilidades de formato y archivos.
 * Sin dependencias del DOM para poder testearlo en Node.
 */

/** 1 234 567 → "1,18 MB" */
export function fmtBytes(bytes, decimals = 2) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const v = bytes / k ** i;
  return `${v.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

/** 125.43 → "2:05.430" */
export function fmtTime(seconds, { ms = true } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  const head = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  if (!ms) return head;
  return `${head}.${String(Math.floor((seconds % 1) * 1000)).padStart(3, '0')}`;
}

/** Factor lineal (0..1.5) → "-12.0 dB" */
export function fmtDb(lin) {
  if (!lin || lin <= 0) return '-∞';
  const db = 20 * Math.log10(lin);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Quita caracteres no válidos en nombres de archivo (Windows + macOS). */
export function sanitizeFilename(name, max = 120) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, max) || 'audio';
}

/** Quita la extensión del nombre de archivo. */
export function stripExtension(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Sustituye tokens en el patrón de nombre.
 * {name} base · {ch} nº de canal · {chn} nombre · {ext} · {sr} frecuencia
 */
export function applyNameTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m
  );
}

/** Descarga un Blob como archivo. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Espera `ms` milisegundos (para ceder el hilo al navegador). */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mezcla (promedia) varios canales en uno solo. */
export function mixChannels(chans) {
  const n = chans[0].length;
  const out = new Float32Array(n);
  for (const ch of chans) {
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const inv = 1 / chans.length;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

/** Pico absoluto de una lista de canales. */
export function peakOf(chans) {
  let p = 0;
  for (const ch of chans) {
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i];
      if (a > p) p = a;
    }
  }
  return p;
}

/**
 * Normaliza los canales si superan `ceiling` (por defecto −0.3 dBFS),
 * para que el WAV de 16 bits no recorte. Devuelve el factor aplicado.
 */
export function normalizeIfClipping(chans, ceilingDb = -0.3) {
  const ceiling = 10 ** (ceilingDb / 20);
  const peak = peakOf(chans);
  if (peak <= 0 || peak <= ceiling) return 1;
  const gain = ceiling / peak;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
  return gain;
}

/** PRNG determinista para el dither (evita resultados distintos cada vez). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}