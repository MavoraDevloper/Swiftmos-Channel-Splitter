/**
 * ffmpeg.js — Carga perezosa de ffmpeg.wasm.
 *
 * Se usa solo cuando hace falta:
 *   · para LEER formatos que el navegador no decodifica (E-AC3, AC-3, DTS,
 *     TrueHD, APE, WMA, MKV…),
 *   · para ESCRIBIR formatos comprimidos (FLAC, MP3, Opus, AAC…).
 *
 * WAV/PCM se genera en JavaScript, sin ffmpeg (ver wav-encoder.js).
 * El módulo se descarga desde un CDN la primera vez; si no hay conexión o la
 * descarga falla, la app sigue funcionando con WAV.
 */

const CORE_VERSION = '0.12.10';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const FFMPEG_ESM = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/+esm`;
const FFMPEG_ESM_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/';

/** @type {import('@ffmpeg/ffmpeg').FFmpeg | null} */
let instance = null;
/** @type {Promise<any> | null} */
let loading = null;
let lastLog = '';
let engineFailed = false;

/**
 * ¿Sigue disponible el motor de conversión? Si falló una vez (sin red, por
 * ejemplo) ya no insistir. Solo se usa para explicar el fallo en pasos de
 * conversión, nunca se muestra el nombre del motor.
 */
export function isEngineAvailable() {
  return !engineFailed;
}

export const isLoaded = () => instance?.loaded === true;

/** Últimas líneas del log de ffmpeg (útil en mensajes de error). */
export const lastLogLines = (n = 12) => lastLog.split('\n').filter(Boolean).slice(-n).join('\n');

/** Carga ffmpeg.wasm (idempotente). */
export async function getFFmpeg(onProgress) {
  if (instance?.loaded) return instance;
  if (loading) return loading;

  loading = (async () => {
    const report = (frac, label) => onProgress?.(Math.max(0, Math.min(1, frac)), label);
    report(0, 'Descargando ffmpeg.wasm…');

    const [{ FFmpeg }, coreJs, coreWasm, workerURL] = await Promise.all([
      import(/* @vite-ignore */ FFMPEG_ESM),
      fetchWithProgress(`${CORE_BASE}/ffmpeg-core.js`, (f) => report(f * 0.2, 'Descargando motor…')),
      fetchWithProgress(`${CORE_BASE}/ffmpeg-core.wasm`, (f) => report(0.2 + f * 0.65, 'Descargando motor…')),
      fetchClassWorker(),
    ]);

    // Los blob: URL evitan problemas de CORS al crear el worker.
    const coreURL = URL.createObjectURL(coreJs);
    const wasmURL = URL.createObjectURL(coreWasm);

    const ff = new FFmpeg();
    ff.on('log', ({ message }) => {
      lastLog = `${lastLog}\n${message}`.trim();
      if (lastLog.length > 8000) lastLog = lastLog.slice(-4000);
    });

    report(0.96, 'Iniciando ffmpeg…');
    await ff.load({ coreURL, wasmURL, classWorkerURL: workerURL });
    URL.revokeObjectURL(coreURL);
    URL.revokeObjectURL(wasmURL);
    URL.revokeObjectURL(workerURL);

    instance = ff;
    report(1, 'Listo');
    return ff;
  })();

  try {
    return await loading;
  } catch (err) {
    engineFailed = true;
    throw err;
  } finally {
    loading = null;
  }
}

/** Descarga (y libera memoria) del módulo. */
export async function terminateFFmpeg() {
  if (loading) {
    await loading.catch(() => {});
  }
  if (instance) {
    try { await instance.terminate(); } catch { /* ya estaba parado */ }
    instance = null;
  }
  lastLog = '';
  engineFailed = false;
}

/**
 * Ejecuta ffmpeg con un archivo de entrada.
 *
 * @param {Uint8Array|ArrayBuffer|Blob} input
 * @param {string} inName        nombre de entrada (con extensión)
 * @param {string[]} outArgs     argumentos de ffmpeg (salida incluida)
 * @param {string} outName       nombre de salida esperado
 * @param {{onProgress?:(p:number)=>void, signal?:AbortSignal}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function run(input, inName, outArgs, outName, opts = {}) {
  const { onProgress, signal } = opts;
  const ff = await getFFmpeg(opts.onLoadProgress);

  // Limpia archivos anteriores por si se canceló una ejecución previa.
  await safe(ff, () => ff.deleteFile(inName));
  await safe(ff, () => ff.deleteFile(outName));

  await ff.writeFile(inName, await toUint8(input));
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  let handler = null;
  const ratio = (await safe(ff, () => ff.getDuration?.(inName))) || 0;
  if (onProgress && ratio) {
    handler = ({ progress }) => onProgress(Math.max(0, Math.min(1, progress)));
    ff.on('progress', handler);
  }

  try {
    const code = await ff.exec(['-hide_banner', '-i', inName, ...outArgs, outName]);
    if (code !== 0) throw new Error(`ffmpeg terminó con código ${code}`);
    const data = await ff.readFile(outName);
    if (typeof data === 'string') throw new Error('ffmpeg devolvió texto unexpectedly');
    return data;
  } catch (err) {
    err.message = `${err.message}\n${lastLogLines(6)}`;
    throw err;
  } finally {
    if (handler) ff.off('progress', handler);
    await safe(ff, () => ff.deleteFile(inName));
    await safe(ff, () => ff.deleteFile(outName));
  }
}

/* ─────────────────────── operaciones de alto nivel ─────────────────────── */

/** Convierte cualquier formato a WAV PCM de 24 bits conservando los canales. */
export async function decodeToWav(file, opts = {}) {
  const bytes = await run(file, safeName(file.name || 'entrada'), [
    '-map', '0:a:0', '-vn',
    '-c:a', 'pcm_s24le',
    '-f', 'wav',
  ], 'salida.wav', opts);
  return bytes;
}

/** Recodifica un WAV mono/multicanal al formato comprimido elegido. */
export async function encodeWithFFmpeg(wavBytes, format, opts = {}) {
  const ext = format.ext;
  const args = ['-map', '0:a:0', ...format.codecArgs, '-f', format.muxer ?? defaultMuxer(ext)];
  return run(wavBytes, 'entrada.wav', args, `salida.${ext}`, opts);
}

function defaultMuxer(ext) {
  switch (ext) {
    case 'mp3': return 'mp3';
    case 'flac': return 'flac';
    case 'opus': return 'opus';
    case 'm4a': return 'ipod';
    case 'aac': return 'adts';
    case 'eac3': return 'eac3';
    case 'ac3': return 'ac3';
    case 'ogg': return 'ogg';
    default: return ext;
  }
}

/* ──────────────────────────────── helpers ──────────────────────────────── */

/** Nombre de entrada seguro: sin rutas ni espacios raros. */
function safeName(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_') || 'entrada';
  return base.length > 60 ? base.slice(-60) : base;
}

/**
 * El worker de @ffmpeg/ffmpeg se crea con `new Worker(new URL('./worker.js',
 * import.meta.url))`, que el navegador bloquea si el módulo viene de un CDN.
 * Solución oficial: pasar `classWorkerURL` como blob:. Ese worker importa
 * "./const.js" y "./errors.js" de forma relativa, y las rutas relativas no
 * existen dentro de un blob, así que descargamos también esos módulos y
 * reescribimos los import a blob: URL absolutos.
 */
async function fetchClassWorker() {
  const res = await fetch(`${FFMPEG_ESM_BASE}worker.js`);
  if (!res.ok) throw new Error(`No se pudo descargar el worker de ffmpeg (HTTP ${res.status})`);
  let source = await res.text();

  const deps = [...new Set([...source.matchAll(/from\s*["']\.\/([^"']+)["']/g)].map((m) => m[1]))];
  await Promise.all(deps.map(async (dep) => {
    const depRes = await fetch(FFMPEG_ESM_BASE + dep);
    if (!depRes.ok) throw new Error(`No se pudo descargar ${dep} (HTTP ${depRes.status})`);
    const url = URL.createObjectURL(new Blob([await depRes.text()], { type: 'text/javascript' }));
    source = source.replaceAll(`"./${dep}"`, `"${url}"`).replaceAll(`'./${dep}'`, `'${url}'`);
  }));

  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar ${url} (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.blob();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
}

async function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new TypeError('run(): entrada no válida');
}

async function safe(ff, fn) {
  try { return await fn(); } catch { return null; }
}