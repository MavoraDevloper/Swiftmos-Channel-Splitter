/**
 * audio-engine.js — Decodificación, mezcla de monitor y análisis.
 *
 * Decodificar con la Web Audio API remuestrea al ritmo del AudioContext, así
 * que el contexto de decodificación se crea con la frecuencia *nativa* que
 * devuelve probe.js (96 kHz, 192 kHz… no se degradan).
 */

import { probeAudio } from './probe.js';
import { decodeToWav } from './ffmpeg.js';

const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
const AudioBufferCtor = globalThis.AudioBuffer;

/** Contenedores que los navegadores modernos decodifican sin ffmpeg. */
const NATIVE = new Set(['wav', 'flac', 'mp4/m4a', 'mpeg', 'ogg vorbis', 'ogg opus', 'ogg flac', 'aiff', 'aifc', 'adts aac', 'caf']);

const PROBE_BYTES = 64 * 1024;
const ctxCache = new Map();

/** ¿Existe soporte para decodificar este archivo sin ffmpeg? */
export function isNativelySupported(probe) {
  return NATIVE.has(String(probe.container || '').toLowerCase());
}

/** Lee solo la cabecera del archivo (no carga el archivo entero en memoria). */
export async function probeFile(file) {
  const head = await file.slice(0, PROBE_BYTES).arrayBuffer();
  return probeAudio(head, file.name);
}

/** Crea (o reutiliza) un AudioContext a una frecuencia concreta. */
function decodeContext(sampleRate) {
  const key = sampleRate || 0;
  let ctx = ctxCache.get(key);
  if (!ctx) {
    ctx = sampleRate ? new AudioContextCtor({ sampleRate }) : new AudioContextCtor();
    ctxCache.set(key, ctx);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  return ctx;
}

/** Contexto de reproducción (el del primer gesto del usuario). */
export function playbackContext() {
  const ctx = decodeContext(0);
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Cierra todos los contextos (solo para depuración). */
export function disposeContexts() {
  for (const ctx of ctxCache.values()) ctx.close().catch(() => {});
  ctxCache.clear();
}

/**
 * Decodifica un archivo a AudioBuffer.
 *
 * @param {File|Blob} file
 * @param {{name?: string, onStage?: (msg: string, frac: number) => void, onWarn?: (msg: string) => void}} [opts]
 * @returns {Promise<{buffer: AudioBuffer, probe: object, engine: 'nativo'|'ffmpeg', bitDepth: number}>}
 */
export async function decodeAudioFile(file, opts = {}) {
  const onStage = opts.onStage ?? (() => {});
  const onWarn = opts.onWarn ?? (() => {});

  onStage('Leyendo cabecera…', 0.02);
  const probe = await probeFile(file);
  warnIfHuge(probe, file, onWarn);

  const native = isNativelySupported(probe);
  onStage(native ? 'Decodificando…' : 'Formato no nativo: preparando ffmpeg…', 0.1);

  if (native) {
    const raw = await file.arrayBuffer();
    const rate = saneRate(probe.sampleRate);
    try {
      const buffer = await decodeContext(rate).decodeAudioData(raw.slice(0));
      return { buffer, probe, engine: 'nativo', bitDepth: bitDepthOf(probe) };
    } catch (err) {
      // Algunos archivos "nativos" fallan (AAC raro, WAV con chunks raros…). Se reintenta con ffmpeg.
      console.warn('Decodificación nativa fallida, se intenta ffmpeg:', err);
      return ffmpegDecode(probe, onStage, null, raw);
    }
  }

  return ffmpegDecode(probe, onStage, file, null);
}

async function ffmpegDecode(probe, onStage, file, rawBuffer) {
  onStage('Descargando/arrancando ffmpeg.wasm (solo la primera vez)…', 0.15);
  const wav = await decodeToWav(file ?? rawBuffer, {
    onLoadProgress: (p) => onStage('Descargando ffmpeg.wasm…', 0.15 + p * 0.45),
    onProgress: (p) => onStage('Convirtiendo a PCM…', 0.6 + p * 0.35),
  });

  onStage('Analizando audio…', 0.96);
  // El WAV que acabamos de generar lleva la frecuencia exacta en la cabecera.
  const wavBytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
  const wavArray = wavBytes.byteOffset === 0 && wavBytes.byteLength === wavBytes.buffer.byteLength
    ? wavBytes.buffer
    : wavBytes.slice(0).buffer;
  const wavProbe = probeAudio(wavArray, 'salida.wav');
  const buffer = await decodeContext(saneRate(wavProbe.sampleRate)).decodeAudioData(wavArray.slice(0));

  return {
    buffer,
    probe: { ...probe, sampleRate: wavProbe.sampleRate || probe.sampleRate, bitDepth: 24 },
    engine: 'ffmpeg',
    bitDepth: 24,
  };
}

function saneRate(rate) {
  if (!rate || !Number.isFinite(rate) || rate < 3000 || rate > 768000) return 0;
  return Math.round(rate);
}

/** Un WAV de 7.1.4 a 96 kHz durante una película ocupa GB: avisa antes de morir. */
const MEM_LIMIT = 1.5 * 1024 ** 3;

/**
 * Memoria que ocupará el AudioBuffer decodificado, en bytes.
 * `frames` son muestras por canal; cada muestra se guarda como Float32.
 */
export function estimateDecodedBytes(probe, fileSize = 0) {
  if (probe.frames && probe.channels) return probe.frames * probe.channels * 4;
  // Sin metadatos: los formatos comprimidos se expanden al decodificar.
  return fileSize * 6;
}

function warnIfHuge(probe, file, onWarn) {
  const bytes = estimateDecodedBytes(probe, file.size);
  if (bytes > MEM_LIMIT) {
    const detail = probe.frames
      ? `unos ${(bytes / 1024 ** 3).toFixed(1)} GB en memoria al decodificarlo`
      : `aprox. ${(bytes / 1024 ** 3).toFixed(1)} GB al decodificar`;
    onWarn(`Este archivo ocupará ${detail}. Si la pestaña se queda sin memoria, prueba con un archivo más corto.`);
  }
}

function bitDepthOf(probe) {
  if (probe.bitDepth) return probe.bitDepth;
  return probe.container === 'FLAC' ? 16 : 16;
}

/* ─────────────────────────── Remuestreo ─────────────────────────── */

/**
 * Devuelve los canales a otra frecuencia usando OfflineAudioContext
 * (filtrado de banda adecuado, no interpolación burda).
 *
 * @param {Float32Array[]} channels
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Promise<Float32Array[]>}
 */
export async function resampleChannels(channels, fromRate, toRate) {
  if (!toRate || toRate === fromRate || channels.length === 0) return channels;

  const frames = channels[0].length;
  const outFrames = Math.max(1, Math.round((frames * toRate) / fromRate));

  const src = new AudioBufferCtor({
    length: frames,
    numberOfChannels: channels.length,
    sampleRate: fromRate,
  });
  for (let c = 0; c < channels.length; c++) src.copyToChannel(channels[c], c);

  const off = new OfflineAudioContext(channels.length, outFrames, toRate);
  const node = off.createBufferSource();
  node.buffer = src;
  node.connect(off.destination);
  node.start();

  const rendered = await off.startRendering();
  return Array.from({ length: rendered.numberOfChannels }, (_, c) => new Float32Array(rendered.getChannelData(c)));
}

/* ─────────────────────────── Picos / forma de onda ─────────────────────────── */

/**
 * Envolvente min/max por canal para dibujar la forma de onda.
 * @returns {{min: Float32Array[], max: Float32Array[], buckets: number}}
 */
export function computePeaks(buffer, buckets = 4000) {
  const chans = buffer.numberOfChannels;
  const length = buffer.length;
  const n = Math.max(1, Math.min(buckets, length));
  const step = length / n;
  const min = [];
  const max = [];

  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    const lo = new Float32Array(n);
    const hi = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * step);
      const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * step)));
      let mn = 1, mx = -1;
      for (let j = start; j < end; j++) {
        const v = data[j];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      lo[i] = mn;
      hi[i] = mx;
    }
    min.push(lo);
    max.push(hi);
  }
  return { min, max, buckets: n };
}

/* ─────────────────────────── Monitor de canales ─────────────────────────── */

/**
 * Reproducción conrutas independientes por canal: isolatesolo/mute por canal,
 * vúmetro por canal y salida «discreta» (sin downmix) o «downmix a 2.0».
 */
export class ChannelMonitor {
  /** @param {AudioBuffer} buffer */
  constructor(buffer) {
    this.buffer = buffer;
    this.ctx = playbackContext();
    this.numberOfChannels = buffer.numberOfChannels;
    this.duration = buffer.duration;

    this.splitter = this.ctx.createChannelSplitter(this.numberOfChannels);
    this.master = this.ctx.createGain();
    this.master.channelCountMode = 'explicit';
    this.master.channelCount = this.numberOfChannels;
    this.master.channelInterpretation = 'discrete';
    this.master.connect(this.ctx.destination);

    this.gains = [];
    this.analysers = [];
    this._meterBuf = new Float32Array(256);

    for (let c = 0; c < this.numberOfChannels; c++) {
      const gain = this.ctx.createGain();
      gain.gain.value = 1;
      this.splitter.connect(gain, c);
      gain.connect(this.master);

      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0;
      gain.connect(analyser);

      this.gains.push(gain);
      this.analysers.push(analyser);
    }

    this.source = null;
    this.playing = false;
    this.startedAt = 0;
    this.offset = 0;
    this.soloIndex = null;
    this.muted = new Set();
    this.loop = false;
  }

  /** Nivel RMS (0..1+) por canal, para los vúmetros. */
  levels() {
    const out = new Float32Array(this.numberOfChannels);
    for (let c = 0; c < this.numberOfChannels; c++) {
      this.analysers[c].getFloatTimeDomainData(this._meterBuf);
      let sum = 0;
      for (let i = 0; i < this._meterBuf.length; i++) sum += this._meterBuf[i] * this._meterBuf[i];
      out[c] = Math.sqrt(sum / this._meterBuf.length);
    }
    return out;
  }

  setMasterGain(value) {
    this.master.gain.value = value;
  }

  /** Aísla un canal (null = todos). */
  setSolo(index) {
    this.soloIndex = index;
    this._applyGains();
  }

  setMuted(index, muted) {
    if (muted) this.muted.add(index);
    else this.muted.delete(index);
    this._applyGains();
  }

  isAudible(index) {
    return (this.soloIndex === null || this.soloIndex === index) && !this.muted.has(index);
  }

  _applyGains() {
    const now = this.ctx.currentTime;
    for (let c = 0; c < this.numberOfChannels; c++) {
      const target = this.isAudible(c) ? 1 : 0;
      this.gains[c].gain.setTargetAtTime(target, now, 0.008);
    }
  }

  get currentTime() {
    if (!this.playing) return this.offset;
    const t = this.offset + (this.ctx.currentTime - this.startedAt);
    return this.loop ? t % this.duration : Math.min(t, this.duration);
  }

  play(offset = this.offset) {
    this.stopSource();
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = this.loop;
    source.connect(this.splitter);
    source.start(0, Math.max(0, Math.min(offset, this.duration - 0.001)));
    source.onended = () => {
      if (this.source === source && !this.loop) {
        this.playing = false;
        this.offset = 0;
        this.source = null;
        this.onEnded?.();
      }
    };
    this.source = source;
    this.offset = offset;
    this.startedAt = this.ctx.currentTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stopSource();
    this.playing = false;
  }

  stop() {
    this.stopSource();
    this.offset = 0;
    this.playing = false;
  }

  seek(time) {
    const t = Math.max(0, Math.min(time, this.duration));
    if (this.playing) this.play(t);
    else this.offset = t;
  }

  setLoop(on) {
    this.loop = on;
    if (this.source) {
      const wasPlaying = this.playing;
      const at = this.currentTime;
      this.pause();
      this.loop = on;
      if (wasPlaying) this.play(at);
      else this.loop = on;
    }
  }

  stopSource() {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* ya estaba parado */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  dispose() {
    this.stopSource();
    try {
      this.splitter.disconnect();
      this.master.disconnect();
      for (const g of this.gains) g.disconnect();
      for (const a of this.analysers) a.disconnect();
    } catch { /* contexto ya cerrado */ }
  }
}