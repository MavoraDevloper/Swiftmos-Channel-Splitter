/**
 * probe.js — Lectura de cabeceras de contenedores de audio.
 *
 * Motivo: `AudioContext.decodeAudioData()` remuestrea a la frecuencia del
 * contexto. Si un archivo es de 96 kHz y el contexto está a 48 kHz, se
 * perdería calidad sin avisar. Por eso inspeccionamos la cabecera para saber
 * la frecuencia *nativa* y crear el contexto de decodificación con ella.
 *
 * Controles soportados: RIFF/WAVE, FLAC, AIFF/AIFC, Ogg (Vorbis/Opus/FLAC),
 * ISO-BMFF (M4A/M4B/MP4/AAC) y tramas MPEG (MP3/MP2).
 */

const dec = new TextDecoder('latin1');

/** Lee los primeros `len` bytes como texto latin1. */
const str = (v, off, len) =>
  dec.decode(new Uint8Array(v.buffer, v.byteOffset + off, Math.max(0, Math.min(len, v.byteLength - off))));

function tag(view, off) {
  return str(view, off, 4);
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{container:string, sampleRate?:number, channels?:number, bitDepth?:number, codec?:string}}
 */
export function probeAudio(buffer, fileName = '') {
  if (!buffer || buffer.byteLength < 16) return { container: 'desconocido' };
  const v = new DataView(buffer);

  const byRiff = probeRiff(v);
  if (byRiff) return byRiff;

  if (tag(v, 0) === 'fLaC') return probeFlac(v);
  if (tag(v, 0) === 'FORM') return probeAiff(v);
  if (tag(v, 0) === 'OggS') return probeOgg(v);
  if (tag(v, 4) === 'ftyp') return probeMp4(v);
  if (tag(v, 0) === 'caff') return probeCaf(v);
  if (tag(v, 0) === 'TTA1' || tag(v, 0) === 'wvpk') {
    return { container: tag(v, 0) === 'TTA1' ? 'TTA' : 'WavPack', ...mpegFallback(fileName) };
  }
  if (tag(v, 0) === 'MAC ') return { container: 'APE', ...mpegFallback(fileName) };
  if (v.getUint16(0, false) === 0x4d4d) return { container: 'CAF', ...mpegFallback(fileName) };

  const mpeg = probeMpegFrame(v);
  if (mpeg) return mpeg;

  return { container: 'desconocido', ...mpegFallback(fileName) };
}

/* ─────────────────────────── RIFF / WAVE ─────────────────────────── */

function probeRiff(v) {
  if (tag(v, 0) !== 'RIFF' || tag(v, 8) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let factFrames = 0;
  let dataBytes = 0;

  while (off + 8 <= v.byteLength) {
    const id = tag(v, off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;

    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        bitDepth: v.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.bitDepth = v.getUint16(body + 18, true) || fmt.bitDepth;
    } else if (id === 'fact') {
      factFrames = size >= 4 ? v.getUint32(body, true) : 0;
    } else if (id === 'data') {
      dataBytes = size;
      break;
    }
    off = body + size + (size % 2); // los chunks se alinean a pares
  }

  if (!fmt || !fmt.sampleRate) return { container: 'WAV' };
  const wavFrames = fmt.blockAlign ? Math.floor(dataBytes / fmt.blockAlign) : 0;
  const codec = fmt.format === 1 ? 'PCM'
    : fmt.format === 3 ? 'IEEE float'
    : fmt.format === 0xfffe ? 'PCM extensible'
    : `WAV 0x${fmt.format.toString(16)}`;
  return {
    container: 'WAV',
    codec,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitDepth,
    frames: factFrames || wavFrames || undefined,
  };
}

/* ──────────────────────────── FLAC ─────────────────────────── */

function probeFlac(v) {
  let off = 4;
  while (off + 4 <= v.byteLength) {
    const isLast = (v.getUint8(off) & 0x80) !== 0;
    const type = v.getUint8(off) & 0x7f;
    const size = (v.getUint8(off + 1) << 16) | (v.getUint8(off + 2) << 8) | v.getUint8(off + 3);
    const body = off + 4;

    if (type === 0 && size >= 18) { // STREAMINFO
      // sampleRate: 20 bits en el byte 10 (bits 80..99 del bloque)
      const sampleRate = (v.getUint8(body + 10) << 12) | (v.getUint8(body + 11) << 4) | (v.getUint8(body + 12) >> 4);
      const channels = ((v.getUint8(body + 12) >> 1) & 0x07) + 1;
      const bitDepth = (((v.getUint8(body + 12) & 0x01) << 4) | (v.getUint8(body + 13) >> 4)) + 1;
      return {
        container: 'FLAC',
        codec: 'FLAC',
        sampleRate: sampleRate || undefined,
        channels,
        bitDepth,
      };
    }
    if (isLast) break;
    off = body + size;
  }
  return { container: 'FLAC' };
}

/* ──────────────────────── AIFF / AIFC ──────────────────────── */

function probeAiff(v) {
  const form = tag(v, 8);
  if (form !== 'AIFF' && form !== 'AIFC') return null;
  if (tag(v, 12) !== 'COMM') return { container: form };

  const numChannels = v.getUint16(16, false);
  const numFrames = v.getUint32(18, false);
  const bitDepth = v.getUint16(22, false);

  // Extendido IEEE-754 de 80 bits en los bytes 24..33
  const exponent = ((v.getUint8(24) & 0x7f) << 8) | v.getUint8(25);
  let mantissa = 0;
  for (let i = 0; i < 8; i++) mantissa = mantissa * 256 + v.getUint8(26 + i);
  let sign = v.getUint8(24) & 0x80 ? -1 : 1;
  if (exponent === 0 && mantissa === 0) sign = 0;
  const sampleRate = sign * mantissa * 2 ** (exponent - 16383 - 63);

  return {
    container: form,
    codec: form === 'AIFC' ? 'AIFC' : 'PCM',
    sampleRate: Math.round(sampleRate),
    channels: numChannels,
    bitDepth,
    frames: numFrames,
  };
}

/* ──────────────────────────── Ogg ──────────────────────────── */

function probeOgg(v) {
  // Cabecera de página Ogg: 27 bytes + tabla de segmentos
  const nseg = v.getUint8(26);
  const start = 27 + nseg;
  const head = str(v, start, 8);

  if (head.startsWith('vorbis')) {
    // identification header: 1 + 6 + 4 + 1 canales + 4 sampleRate
    return {
      container: 'Ogg Vorbis',
      codec: 'Vorbis',
      sampleRate: v.getUint32(start + 12, true),
      channels: v.getUint8(start + 11),
    };
  }
  if (head.startsWith('OpusHead')) {
    // 8 + versión(1) + canales(1) + preskip(2) + inputSampleRate(4)
    return {
      container: 'Ogg Opus',
      codec: 'Opus',
      // "Input sample rate" NO es la de salida (Opus siempre decodifica a 48 kHz).
      channels: v.getUint8(start + 9),
      sampleRate: 48000,
      originalSampleRate: v.getUint32(start + 12, true) || undefined,
    };
  }
  if (head.startsWith('\x7fFLAC')) {
    // El bloque STREAMINFO va justo detrás de "fLaC"+4 bytes de cabecera
    const body = start + 13;
    const sampleRate = (v.getUint8(body + 10) << 12) | (v.getUint8(body + 11) << 4) | (v.getUint8(body + 12) >> 4);
    const channels = ((v.getUint8(body + 12) >> 1) & 0x07) + 1;
    const bitDepth = (((v.getUint8(body + 12) & 0x01) << 4) | (v.getUint8(body + 13) >> 4)) + 1;
    return { container: 'Ogg FLAC', codec: 'FLAC', sampleRate: sampleRate || undefined, channels, bitDepth };
  }
  return { container: 'Ogg' };
}

/* ──────────────────── ISO-BMFF: M4A / MP4 / AAC ──────────────────── */

function* boxes(v, start, end) {
  let off = start;
  while (off + 8 <= end) {
    let size = v.getUint32(off);
    const type = tag(v, off + 4);
    let headerSize = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(off + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < headerSize || off + size > end) return;
    yield { type, dataStart: off + headerSize, end: off + size };
    off += size;
  }
}

function mdhdDuration(v, box) {
  const version = v.getUint8(box.dataStart);
  return version === 1 ? Number(v.getBigUint64(box.dataStart + 24)) : v.getUint32(box.dataStart + 16, false);
}

function mdhdTimescale(v, box) {
  const version = v.getUint8(box.dataStart);
  return version === 1 ? v.getUint32(box.dataStart + 20, false) : v.getUint32(box.dataStart + 12, false);
}

function probeMp4(v) {
  const out = { container: 'MP4/M4A', codec: 'AAC' };
  let moov = null;
  for (const b of boxes(v, 0, v.byteLength)) if (b.type === 'moov') moov = b;
  if (!moov) return out;

  for (const trak of boxes(v, moov.dataStart, moov.end)) {
    if (trak.type !== 'trak') continue;
    for (const mdia of boxes(v, trak.dataStart, trak.end)) {
      if (mdia.type !== 'mdia') continue;
      let isSound = false;
      let timescale = 0;
      let duration = 0;
      for (const sub of boxes(v, mdia.dataStart, mdia.end)) {
        if (sub.type === 'mdhd') {
          timescale = mdhdTimescale(v, sub);
          duration = mdhdDuration(v, sub);
        }
        if (sub.type === 'hdlr') {
          const handler = str(v, sub.dataStart + 8, 4);
          if (handler === 'soun') isSound = true;
        }
      }
      if (isSound && timescale > 3000 && timescale < 500000) {
        out.sampleRate = timescale;
        out.codec = 'AAC';
        if (duration > 0) out.frames = duration; // timescale == frecuencia de la pista
        break;
      }
    }
    if (out.sampleRate) break;
  }
  return out;
}

/* ──────────────────────────── CAF ──────────────────────────── */

function probeCaf(v) {
  // 'caff' + versión(4) + flags(4) → mAudioFloatRate (float64 BE) en el byte 20
  const buf = new ArrayBuffer(8);
  const out = new DataView(buf);
  out.setUint32(0, v.getUint32(20));
  out.setUint32(4, v.getUint32(24));
  const sampleRate = Math.round(out.getFloat64(0));
  return { container: 'CAF', sampleRate: sampleRate > 100 ? sampleRate : undefined };
}

/* ──────────────────── Trama MPEG-1/2/2.5 (MP3) ──────────────────── */

const MPEG_RATES = [
  [11025, 12000, 8000],   // MPEG 2.5
  null,                   // reservado
  [22050, 24000, 16000],  // MPEG 2
  [44100, 48000, 32000],  // MPEG 1
];

/**
 * Decodifica una cabecera de trama MPEG.
 * Byte 1: AAAAAAAA AAABBCCD → versión = bits 4-3, capa = bits 2-1
 * Byte 2: EEEEFFGH     → bitrate = bits 7-4,  frecuencia = bits 3-2
 */
function parseMpegHeader(v, off) {
  if (off + 4 > v.byteLength) return null;
  const b1 = v.getUint8(off + 1);
  if (v.getUint8(off) !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const rates = MPEG_RATES[versionBits];
  if (!rates) return null;                       // versión reservada

  const layerBits = (b1 >> 1) & 0x03;
  if (layerBits === 0) return null;              // capa reservada
  const layer = 4 - layerBits;                   // 1, 2 o 3

  const b2 = v.getUint8(off + 2);
  const rateIndex = (b2 >> 2) & 0x03;
  if (rateIndex === 3) return null;              // reservado
  const bitrateIndex = (b2 >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null; // libre / inválido

  const b3 = v.getUint8(off + 3);
  const channels = ((b3 >> 6) & 0x03) === 3 ? 1 : 2;

  return {
    versionBits,
    layer,
    sampleRate: rates[rateIndex],
    channels,
    codec: layer === 3 ? 'MP3' : layer === 2 ? 'MP2' : 'MP1',
  };
}

/** Busca el primer inicio de trama válido (tolera etiquetas ID3). */
function probeMpegFrame(v) {
  const limit = Math.min(v.byteLength, 8192) - 4;
  for (let off = 0; off <= limit; off++) {
    const h = parseMpegHeader(v, off);
    if (!h) continue;
    // Confirmación: debe haber otra trama con la misma versión/capa cerca.
    let confirmed = false;
    for (let k = off + 4; k < Math.min(v.byteLength, off + 4096); k++) {
      const h2 = parseMpegHeader(v, k);
      if (h2 && h2.versionBits === h.versionBits && h2.layer === h.layer) { confirmed = true; break; }
    }
    if (!confirmed) continue;
    return { container: 'MPEG', codec: h.codec, sampleRate: h.sampleRate, channels: h.channels, bitDepth: 16 };
  }
  return null;
}

/* ──────────────────────────── extras ──────────────────────────── */

/** Extensión del archivo como pista cuando la cabecera no aporta nada. */
function mpegFallback(fileName) {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(fileName || '') || [])[1];
  if (!ext) return {};
  const known = {
    flac: { container: 'FLAC', codec: 'FLAC' },
    wav: { container: 'WAV', codec: 'PCM' },
    wave: { container: 'WAV', codec: 'PCM' },
    m4a: { container: 'MP4/M4A', codec: 'AAC' },
    m4b: { container: 'MP4/M4A', codec: 'AAC' },
    mp4: { container: 'MP4/M4A', codec: 'AAC' },
    aac: { container: 'ADTS AAC', codec: 'AAC' },
    mp3: { container: 'MPEG', codec: 'MP3' },
    ogg: { container: 'Ogg', codec: 'Vorbis/Opus' },
    oga: { container: 'Ogg', codec: 'Vorbis' },
    opus: { container: 'Ogg', codec: 'Opus', sampleRate: 48000 },
    aiff: { container: 'AIFF', codec: 'PCM' },
    aif: { container: 'AIFF', codec: 'PCM' },
    aifc: { container: 'AIFC', codec: 'PCM' },
    eac3: { container: 'E-AC3', codec: 'E-AC3' },
    ec3: { container: 'E-AC3', codec: 'E-AC3' },
    ac3: { container: 'AC-3', codec: 'AC-3' },
    dts: { container: 'DTS', codec: 'DTS' },
    thd: { container: 'TrueHD', codec: 'TrueHD' },
    truehd: { container: 'TrueHD', codec: 'TrueHD' },
    wma: { container: 'ASF', codec: 'WMA' },
    mka: { container: 'Matroska', codec: 'Matroska audio' },
  };
  return known[ext.toLowerCase()] || {};
}