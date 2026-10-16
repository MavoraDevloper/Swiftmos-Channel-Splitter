/**
 * wav-encoder.js — Codificador WAV (RIFF) puro en JavaScript.
 *
 * Soporta 16 bits PCM, 24 bits PCM y 32 bits IEEE float, con dither TPDF
 * opcional y normalización. Sin dependencias: se puede testear en Node.
 */

import { mulberry32 } from './utils.js';

/** Bytes que ocupa en el archivo una muestra de un canal. */
const bytesPerSample = (bitDepth) => (bitDepth === 32 ? 4 : bitDepth / 8);

/**
 * Codifica uno o varios canales a un WAV.
 *
 * @param {Float32Array[]} channels  datos con valores en [-1, 1]
 * @param {number} sampleRate
 * @param {{bitDepth?: 16|24|32, dither?: boolean}} [opts]
 * @returns {Blob}
 */
export function encodeWav(channels, sampleRate, opts = {}) {
  if (!channels || channels.length === 0) throw new Error('encodeWav: no hay canales');
  const { bitDepth = 24, dither = bitDepth === 16 } = opts;
  const nch = channels.length;
  const frames = channels[0].length;
  const bps = bytesPerSample(bitDepth);
  const blockAlign = nch * bps;
  const dataBytes = frames * blockAlign;

  const isFloat = bitDepth === 32;
  const fmtChunkSize = isFloat ? 18 : 16;
  const factChunkSize = isFloat ? 12 : 0;
  const headerSize = 12 + 8 + fmtChunkSize + (factChunkSize ? 8 + factChunkSize : 0);
  // El chunk "data" debe ocupar un número par de bytes.
  const padByte = dataBytes % 2;
  const total = headerSize + 8 + dataBytes + padByte;

  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };

  /* ── Cabecera RIFF ── */
  ascii(0, 'RIFF');
  view.setUint32(4, total - 8, true);
  ascii(8, 'WAVE');

  /* ── fmt ── */
  let off = 12;
  ascii(off, 'fmt ');
  view.setUint32(off + 4, fmtChunkSize, true);
  off += 8;
  view.setUint16(off, isFloat ? 3 : 1, true);          // wFormatTag
  view.setUint16(off + 2, nch, true);                 // nChannels
  view.setUint32(off + 4, sampleRate, true);           // nSamplesPerSec
  view.setUint32(off + 8, sampleRate * blockAlign, true); // nAvgBytesPerSec
  view.setUint16(off + 12, blockAlign, true);          // nBlockAlign
  view.setUint16(off + 14, bitDepth, true);            // wBitsPerSample
  if (isFloat) view.setUint16(off + 16, 0, true);      // cbSize
  off += fmtChunkSize;

  /* ── fact (obligatorio en float) ── */
  if (isFloat) {
    ascii(off, 'fact');
    view.setUint32(off + 4, 4, true);
    view.setUint32(off + 8, frames, true);             // nº de muestras por canal
    off += 12;
  }

  /* ── data ── */
  ascii(off, 'data');
  view.setUint32(off + 4, dataBytes, true);
  off += 8;

  writeSamples(view, off, channels, frames, nch, bitDepth, dither);
  if (padByte) view.setUint8(off + dataBytes, 0);

  return new Blob([out], { type: 'audio/wav' });
}

/** Rellena el búfer con las muestras intercaladas. */
function writeSamples(view, off, channels, frames, nch, bitDepth, dither) {
  const rnd = dither ? mulberry32(0x9e3779b9) : null;

  if (bitDepth === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        let s = channels[c][i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        // Dither TPDF de amplitud 1 LSB (±0.5 LSB Pico)
        if (dither) s += (rnd() + rnd() - 1) * (1 / 32768);
        view.setInt16(off, Math.round(s * 32767), true);
        off += 2;
      }
    }
    return;
  }

  if (bitDepth === 24) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        let s = channels[c][i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        const v = Math.round(s * 8388607);
        view.setUint8(off, v & 0xff);
        view.setUint8(off + 1, (v >> 8) & 0xff);
        view.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      }
    }
    return;
  }

  // 32 bits IEEE float
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      view.setFloat32(off, channels[c][i], true);
      off += 4;
    }
  }
}