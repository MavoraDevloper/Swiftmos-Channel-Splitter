/**
 * channel-layouts.js — Distribuciones de canales y sus nombres.
 *
 * El orden importa: cada canal del archivo se exporta tal cual aparece en el
 * búfer decodificado. Los nombres siguen la convención de RIFF WAVE / FFmpeg,
 * que es la que usan casi todos los programas al escribir audio multicanal.
 */

/** @typedef {{id:string, name:string, channels:{code:string, name:string, short:string, lfe?:boolean}[]}} Layout */

/** @type {Layout[]} */
export const LAYOUTS = [
  {
    id: 'mono',
    name: 'Mono (1.0)',
    channels: [{ code: 'M', name: 'Mono', short: 'Mono' }],
  },
  {
    id: 'stereo',
    name: 'Estéreo (2.0)',
    channels: [
      { code: 'L', name: 'Izquierdo', short: 'Izq.' },
      { code: 'R', name: 'Derecho', short: 'Der.' },
    ],
  },
  {
    id: '2.1',
    name: '2.1 (L / R / LFE)',
    channels: [
      { code: 'L', name: 'Izquierdo', short: 'Izq.' },
      { code: 'R', name: 'Derecho', short: 'Der.' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
    ],
  },
  {
    id: 'quad',
    name: 'Cuadraphonic (4.0)',
    channels: [
      { code: 'L', name: 'Izquierdo', short: 'Izq.' },
      { code: 'R', name: 'Derecho', short: 'Der.' },
      { code: 'BL', name: 'Trasero izquierdo', short: 'Tras. izq.' },
      { code: 'BR', name: 'Trasero derecho', short: 'Tras. der.' },
    ],
  },
  {
    id: '5.0',
    name: '5.0 sin LFE',
    channels: [
      { code: 'L', name: 'Izquierdo', short: 'Izq.' },
      { code: 'R', name: 'Derecho', short: 'Der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'SL', name: 'Lateral izquierdo', short: 'Lat. izq.' },
      { code: 'SR', name: 'Lateral derecho', short: 'Lat. der.' },
    ],
  },
  {
    id: '5.1',
    name: '5.1 — L R C LFE SL SR (WAVE)',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'SL', name: 'Lateral izquierdo', short: 'Lat. izq.' },
      { code: 'SR', name: 'Lateral derecho', short: 'Lat. der.' },
    ],
  },
  {
    id: '5.1back',
    name: '5.1 — L R C LFE BL BR (traseros)',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'BL', name: 'Trasero izquierdo', short: 'Tras. izq.' },
      { code: 'BR', name: 'Trasero derecho', short: 'Tras. der.' },
    ],
  },
  {
    id: '6.1',
    name: '6.1 — añade canal trasero central',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'SL', name: 'Lateral izquierdo', short: 'Lat. izq.' },
      { code: 'SR', name: 'Lateral derecho', short: 'Lat. der.' },
      { code: 'BC', name: 'Trasero central', short: 'Tras. centro' },
    ],
  },
  {
    id: '7.1',
    name: '7.1 — L R C LFE BL BR SL SR',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'BL', name: 'Trasero izquierdo', short: 'Tras. izq.' },
      { code: 'BR', name: 'Trasero derecho', short: 'Tras. der.' },
      { code: 'SL', name: 'Lateral izquierdo', short: 'Lat. izq.' },
      { code: 'SR', name: 'Lateral derecho', short: 'Lat. der.' },
    ],
  },
  {
    id: '7.1side',
    name: '7.1 — L R C LFE SL SR BL BR (laterales primero)',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'SL', name: 'Lateral izquierdo', short: 'Lat. izq.' },
      { code: 'SR', name: 'Lateral derecho', short: 'Lat. der.' },
      { code: 'BL', name: 'Trasero izquierdo', short: 'Tras. izq.' },
      { code: 'BR', name: 'Trasero derecho', short: 'Tras. der.' },
    ],
  },
  {
    id: '7.1.2',
    name: '7.1.2 — con altura frontal',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'BL', name: 'Trasero izquierdo', short: 'Tras. izq.' },
      { code: 'BR', name: 'Trasero derecho', short: 'Tras. der.' },
      { code: 'SL', name: 'Lateral izquierdo', short: 'Lat. izq.' },
      { code: 'SR', name: 'Lateral derecho', short: 'Lat. der.' },
      { code: 'TFL', name: 'Altura frontal izq.', short: 'Alt. frontal izq.' },
      { code: 'TFR', name: 'Altura frontal der.', short: 'Alt. frontal der.' },
    ],
  },
  {
    id: '7.1.4',
    name: '7.1.4 — L R C LFE BL BR SL SR LSS RSS LTF RTF',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'BL', name: 'Trasero izquierdo', short: 'Tras. izq.' },
      { code: 'BR', name: 'Trasero derecho', short: 'Tras. der.' },
      { code: 'SL', name: 'Lateral izquierdo', short: 'Lat. izq.' },
      { code: 'SR', name: 'Lateral derecho', short: 'Lat. der.' },
      { code: 'LSS', name: 'Altura Surround izq.', short: 'Alt. lat. izq.' },
      { code: 'RSS', name: 'Altura Surround der.', short: 'Alt. lat. der.' },
      { code: 'LTF', name: 'Altura frontal izq.', short: 'Alt. frontal izq.' },
      { code: 'RTF', name: 'Altura frontal der.', short: 'Alt. frontal der.' },
    ],
  },
  {
    id: '7.1.4adm',
    name: '7.1.4 — orden ADM / Atmos',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'LSS', name: 'Altura Surround izq.', short: 'Alt. lat. izq.' },
      { code: 'RSS', name: 'Altura Surround der.', short: 'Alt. lat. der.' },
      { code: 'LTF', name: 'Altura frontal izq.', short: 'Alt. frontal izq.' },
      { code: 'RTF', name: 'Altura frontal der.', short: 'Alt. frontal der.' },
      { code: 'LRS', name: 'Trasero izq.', short: 'Tras. izq.' },
      { code: 'RRS', name: 'Trasero der.', short: 'Tras. der.' },
      { code: 'LRH', name: 'Altura trasera izq.', short: 'Alt. tras. izq.' },
      { code: 'RRH', name: 'Altura trasera der.', short: 'Alt. tras. der.' },
    ],
  },
  {
    id: '7.1.6',
    name: '7.1.6 — 16 canales',
    channels: [
      { code: 'L', name: 'Frontal izquierdo', short: 'Frontal izq.' },
      { code: 'R', name: 'Frontal derecho', short: 'Frontal der.' },
      { code: 'C', name: 'Central', short: 'Centro' },
      { code: 'LFE', name: 'Graves', short: 'LFE', lfe: true },
      { code: 'BL', name: 'Trasero izquierdo', short: 'Tras. izq.' },
      { code: 'BR', name: 'Trasero derecho', short: 'Tras. der.' },
      { code: 'SL', name: 'Lateral izquierdo', short: 'Lat. izq.' },
      { code: 'SR', name: 'Lateral derecho', short: 'Lat. der.' },
      { code: 'LSS', name: 'Altura Surround izq.', short: 'Alt. lat. izq.' },
      { code: 'RSS', name: 'Altura Surround der.', short: 'Alt. lat. der.' },
      { code: 'LTF', name: 'Altura frontal izq.', short: 'Alt. frontal izq.' },
      { code: 'RTF', name: 'Altura frontal der.', short: 'Alt. frontal der.' },
      { code: 'LC', name: 'Lateral frontal izq.', short: 'Lat. frontal izq.' },
      { code: 'RC', name: 'Lateral frontal der.', short: 'Lat. frontal der.' },
      { code: 'LRS', name: 'Trasero izq.', short: 'Tras. izq.' },
      { code: 'RRS', name: 'Trasero der.', short: 'Tras. der.' },
    ],
  },
];

const CHANNEL_COLORS = [
  '#60a5fa', '#f472b6', '#34d399', '#fbbf24',
  '#a78bfa', '#22d3ee', '#fb923c', '#4ade80',
];

export const channelColor = (i) => CHANNEL_COLORS[i % CHANNEL_COLORS.length];

/** Devuelve la distribución más probable para un número de canales. */
export function defaultLayoutFor(count) {
  const exact = LAYOUTS.find((l) => l.channels.length === count);
  if (exact) return exact;
  // Fallback: genérico 1..N
  return {
    id: `generic-${count}`,
    name: `Genérico — ${count} canales`,
    channels: Array.from({ length: count }, (_, i) => ({
      code: `CH${i + 1}`,
      name: `Canal ${i + 1}`,
      short: `Canal ${i + 1}`,
    })),
  };
}

/** Todas las distribuciones (incluida la genérica) compatibles con `count`. */
export function layoutsForCount(count) {
  return LAYOUTS.filter((l) => l.channels.length === count);
}
