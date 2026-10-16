/**
 * zip.js — Escritor ZIP mínimo (método store y deflate).
 *
 * Se usa `CompressionStream('deflate-raw')` cuando está disponible (Chrome 80+,
 * Firefox 113+, Safari 16.4+); si no, se guardan sin comprimir. Los offsets se
 * calculan por adelantado, así que el ZIP se arma como una lista de fragments
 * de Blob en vez de un búfer gigante.
 */

/** Límite práctico del formato ZIP classic (4 GiB por entrada / archivo). */
export const ZIP_LIMIT = 0xffffffff;

/* ─────────────────────────────── CRC-32 ─────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ──────────────────────────── Fecha DOS ──────────────────────────── */

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
  };
}

/* ─────────────────────────── Compresión ─────────────────────────── */

/**
 * El método 8 del ZIP guarda DEFLATE **crudo** (sin cabecera zlib), así que
 * solo sirve 'deflate-raw'. Si el motor no lo soporta (p. ej. Node 18), se
 * guardan las entradas sin comprimir: un ZIP "stored" sigue siendo válido.
 */
const DEFLATE_FORMAT = (() => {
  if (typeof CompressionStream !== 'function') return null;
  try {
    new CompressionStream('deflate-raw'); // eslint-disable-line no-new
    return 'deflate-raw';
  } catch {
    return null;
  }
})();

async function deflateData(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(DEFLATE_FORMAT));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ──────────────────────────────── API ─────────────────────────────── */

/**
 * @typedef {{name: string, data: Uint8Array|ArrayBuffer|Blob}} ZipEntry
 */

/**
 * Crea un ZIP en memoria.
 * @param {ZipEntry[]} entries
 * @param {{onProgress?: (done:number, total:number) => void, signal?: AbortSignal}} [opts]
 * @returns {Promise<{blob: Blob, compressed: boolean, totalBytes: number}>}
 */
export async function makeZip(entries, opts = {}) {
  if (!entries.length) throw new Error('makeZip: sin entradas');
  const { onProgress, signal } = opts;

  const encoder = new TextEncoder();
  const { time, date } = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

    const entry = entries[i];
    const nameBytes = encoder.encode(entry.name.replace(/^\/+/, ''));
    const raw = await toUint8(entry.data);
    if (raw.byteLength > ZIP_LIMIT) throw new Error(`"${entry.name}" supera el límite de 4 GiB del ZIP`);

    let method = 0;
    let payload = raw;
    if (DEFLATE_FORMAT && raw.byteLength > 512) {
      const deflated = await deflateData(raw);
      if (deflated.byteLength < raw.byteLength) {
        method = 8;
        payload = deflated;
      }
    }

    const crc = crc32(raw);

    /* ── Cabecera local ── */
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // versión necesaria
    local.setUint16(6, 0x0800, true);      // nombres en UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, payload.byteLength, true);
    local.setUint32(22, raw.byteLength, true);
    local.setUint16(26, nameBytes.byteLength, true);
    local.setUint16(28, 0, true);          // sin campo extra

    parts.push(local.buffer, nameBytes, payload);

    /* ── Directorio central ── */
    central.push({ nameBytes, crc, compressed: payload.byteLength, size: raw.byteLength, method, offset });

    offset += 30 + nameBytes.byteLength + payload.byteLength;
    onProgress?.(i + 1, entries.length);
  }

  /* ── Directorio central ── */
  const cdParts = [];
  let cdSize = 0;
  for (const e of central) {
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);          // versión creador
    head.setUint16(6, 20, true);          // versión necesaria
    head.setUint16(8, 0x0800, true);
    head.setUint16(10, e.method, true);
    head.setUint16(12, time, true);
    head.setUint16(14, date, true);
    head.setUint32(16, e.crc, true);
    head.setUint32(20, e.compressed, true);
    head.setUint32(24, e.size, true);
    head.setUint16(28, e.nameBytes.byteLength, true);
    head.setUint16(30, 0, true);          // extra
    head.setUint16(32, 0, true);          // comentario
    head.setUint16(34, 0, true);          // nº de disco
    head.setUint16(36, 0, true);          // atributos internos
    head.setUint32(38, 0o644 << 16, true);// atributos externos (rw-r--r--)
    head.setUint32(42, e.offset, true);
    cdParts.push(head.buffer, e.nameBytes);
    cdSize += 46 + e.nameBytes.byteLength;
  }

  /* ── Fin del directorio central ── */
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return {
    blob: new Blob([...parts, ...cdParts, end.buffer], { type: 'application/zip' }),
    compressed: central.some((e) => e.method === 8),
    totalBytes: offset + cdSize,
  };
}

async function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new TypeError('makeZip: entrada no válida');
}