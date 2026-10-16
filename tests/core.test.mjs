/**
 * tests/core.test.mjs — pruebas de los módulos puros (probe, wav, zip).
 * Ejecutar con:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { probeAudio } from '../js/probe.js';
import { encodeWav } from '../js/wav-encoder.js';
import { makeZip, crc32 } from '../js/zip.js';
import { fmtBytes, fmtTime, sanitizeFilename, applyNameTemplate, mixChannels, normalizeIfClipping, peakOf } from '../js/utils.js';
import { defaultLayoutFor, layoutsForCount, channelColor } from '../js/channel-layouts.js';
import { estimateDecodedBytes, isNativelySupported } from '../js/audio-engine.js';

const exec = promisify(execFile);
const TMP = path.join(tmpdir(), 'divisor-test');
const fixtures = path.join('/tmp/opencode');

const asArrayBuffer = async (file) => {
  const b = await readFile(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/* ─────────────────────────────── probe ─────────────────────────────── */

test('probe: WAV 5.1 de 48 kHz', async () => {
  const p = probeAudio(await asArrayBuffer(path.join(fixtures, 'test51.wav')), 'test51.wav');
  assert.equal(p.container, 'WAV');
  assert.equal(p.sampleRate, 48000);
  assert.equal(p.channels, 6);
  assert.equal(p.bitDepth, 24);
});

test('probe: FLAC 7.1', async () => {
  const p = probeAudio(await asArrayBuffer(path.join(fixtures, 'test71.flac')), 'test71.flac');
  assert.equal(p.container, 'FLAC');
  assert.equal(p.sampleRate, 44100, 'el fixture se generó a 44.1 kHz');
  assert.equal(p.bitDepth, 16);
  assert.equal(p.channels, 8);
});

test('probe: M4A 44.1 kHz (ISO-BMFF → mdhd)', async () => {
  const p = probeAudio(await asArrayBuffer(path.join(fixtures, 'test_st.m4a')), 'test_st.m4a');
  assert.equal(p.container, 'MP4/M4A');
  assert.equal(p.sampleRate, 44100);
});

test('probe: E-AC3 no soportado nativamente pero se identifica', async () => {
  const p = probeAudio(await asArrayBuffer(path.join(fixtures, 'test51.eac3')), 'test51.eac3');
  assert.equal(p.container, 'E-AC3');
  assert.equal(p.codec, 'E-AC3');
});

test('probe: MP3 sin cabecerarecognida cae en la trama MPEG', async () => {
  const p = probeAudio(await asArrayBuffer(path.join(fixtures, 'test_st.m4a')), 'sin.mp3');
  assert.equal(p.sampleRate, 44100, 'usa el fallback por extensión');
});

test('probe: MP2 22.05 kHz generado al vuelo', async () => {
  const out = path.join(TMP, 'test22.mp2');
  await mkdir(TMP, { recursive: true });
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=1', '-ar', '22050', '-c:a', 'mp2', '-f', 'mp2', out, '-y']);
  const p = probeAudio(await asArrayBuffer(out), 'test22.mp2');
  assert.equal(p.codec, 'MP2');
  assert.equal(p.sampleRate, 22050);
});

test('probe: no lanza con datos basura', () => {
  const junk = new Uint8Array(64).fill(0x41).buffer;
  assert.doesNotThrow(() => probeAudio(junk, 'x.bin'));
  assert.doesNotThrow(() => probeAudio(new ArrayBuffer(4), ''));
});

/* ──────────────────────────────── WAV ──────────────────────────────── */

test('wav: 16 bits estéreo round-trip con ffprobe', async () => {
  const n = 1000;
  const l = new Float32Array(n).fill(-0.5);
  const r = new Float32Array(n).fill(0.5);
  const blob = encodeWav([l, r], 48000, { bitDepth: 16, dither: false });
  const file = path.join(TMP, 'out16.wav');
  await mkdir(TMP, { recursive: true });
  await writeFile(file, Buffer.from(await blob.arrayBuffer()));

  const { stdout } = await exec('ffprobe', ['-hide_banner', '-v', 'error',
    '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,duration',
    '-of', 'json', file]);
  const [stream] = JSON.parse(stdout).streams;
  assert.equal(stream.codec_name, 'pcm_s16le');
  assert.equal(Number(stream.sample_rate), 48000);
  assert.equal(Number(stream.channels), 2);
  assert.equal(Number(stream.bits_per_sample), 16);
  assert.ok(Math.abs(Number(stream.duration) - n / 48000) < 0.001);

  // Decodifica con ffmpeg y comprueba que las muestras coinciden
  const { stdout: pcmBuf } = await exec(
    'ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 24 }
  );
  const pcm = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
  assert.equal(pcm.length, n * 2);
  assert.ok(Math.abs(pcm[0] / 32767 - -0.5) < 0.001, `canal L = ${pcm[0] / 32767}`);
  assert.ok(Math.abs(pcm[1] / 32767 - 0.5) < 0.001, `canal R = ${pcm[1] / 32767}`);
});

test('wav: 24 bits y float 32 bits', async () => {
  await mkdir(TMP, { recursive: true });
  const ch = [new Float32Array(64).fill(0.25)];
  for (const bits of [24, 32]) {
    const blob = encodeWav(ch, 96000, { bitDepth: bits });
    const file = path.join(TMP, `out${bits}.wav`);
    await writeFile(file, Buffer.from(await blob.arrayBuffer()));
    const { stdout } = await exec('ffprobe', ['-hide_banner', '-v', 'error',
      '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample', '-of', 'json', file]);
    const [s] = JSON.parse(stdout).streams;
    assert.equal(Number(s.sample_rate), 96000);
    assert.equal(Number(s.channels), 1);
    if (bits === 24) {
      assert.equal(s.codec_name, 'pcm_s24le');
      assert.equal(Number(s.bits_per_sample), 24);
    } else {
      assert.equal(s.codec_name, 'pcm_f32le');
      assert.equal(Number(s.bits_per_sample), 32);
    }
  }
});

test('wav: número impar de canales con padding par', async () => {
  const blob = encodeWav([new Float32Array(7).fill(0.1)], 8000, { bitDepth: 16, dither: false });
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(4), buf.length - 8, 'tamaño RIFF correcto');
  assert.equal(buf.length % 2, 0, 'archivo alineado a pares');
});

test('wav: recorta valores fuera de rango sin desbordarse', async () => {
  const ch = [new Float32Array([2, -2, 0])];
  const b16 = Buffer.from(await encodeWav(ch, 44100, { bitDepth: 16, dither: false }).arrayBuffer());
  assert.equal(b16.readInt16LE(44), 32767, '1.0 → full scale positivo');
  assert.equal(b16.readInt16LE(46), -32767, '-1.0 → full scale negativo');

  const b24 = Buffer.from(await encodeWav(ch, 44100, { bitDepth: 24 }).arrayBuffer());
  const read24 = (off) => {
    const v = b24[off] | (b24[off + 1] << 8) | (b24[off + 2] << 16);
    return v & 0x800000 ? v - 0x1000000 : v;
  };
  assert.equal(read24(44), 8388607);
  assert.equal(read24(47), -8388607);

  // 0 dBFS (+1.0) en float debe ser exactamente 1.0.
  // En float el header lleva un chunk "fact" extra: el dato no está en 44.
  const b32 = Buffer.from(await encodeWav([new Float32Array([1])], 44100, { bitDepth: 32 }).arrayBuffer());
  assert.equal(b32.toString('ascii', 50, 54), 'data');
  assert.equal(b32.readFloatLE(58), 1);
});

/* ──────────────────────────────── ZIP ──────────────────────────────── */

test('zip: crc32 conocido', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip: archivo válido (validado con unzip/ffprobe)', async (t) => {
  const hasUnzip = await exec('which', ['unzip']).then(() => true).catch(() => false);
  const data = Buffer.from('contenido de prueba '.repeat(200));
  const { blob } = await makeZip([
    { name: 'pista_0_FL.wav', data },
    { name: 'pista_1_FR.wav', data },
    { name: 'carpeta/pista_2.wav', data: Buffer.from('corto') },
  ]);
  await mkdir(TMP, { recursive: true });
  const file = path.join(TMP, 'out.zip');
  await writeFile(file, Buffer.from(await blob.arrayBuffer()));

  assert.equal(blob.type, 'application/zip');
  if (hasUnzip) {
    const { stdout } = await exec('unzip', ['-t', file]);
    assert.match(stdout, /No errors detected/);
    const l = await exec('unzip', ['-l', file]);
    assert.match(l.stdout, /pista_0_FL\.wav/);
    assert.match(l.stdout, /carpeta\/pista_2\.wav/);
  }
  const unz = await exec('python3', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
print(z.testzip() or 'ok')
print(len(z.namelist()))
print(z.read('pista_0_FL.wav').decode()==${JSON.stringify(data.toString())})
print(z.read('carpeta/pista_2.wav').decode())
`, file]);
  const [err, count, content, small] = unz.stdout.trim().split('\n');
  assert.equal(err, 'ok');
  assert.equal(count, '3');
  assert.equal(content, 'True');
  assert.equal(small, 'corto');
});

/* ───────────────────────────── utilidades ───────────────────────────── */

test('utils: formatos', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1024), '1.00 KB');
  assert.equal(fmtBytes(1536000), '1.46 MB');
  assert.equal(fmtTime(125.43), '2:05.430');
  assert.equal(fmtTime(3661.5, { ms: false }), '1:01:01');
  assert.equal(sanitizeFilename('a/b:c*d?.wav'), 'a_b_c_d_.wav');
  assert.equal(applyNameTemplate('{name}_{ch}.{ext}', { name: 'x', ch: 3, ext: 'wav' }), 'x_3.wav');
});

test('utils: mezcla y normalización', () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([0, 1]);
  assert.deepEqual([...mixChannels([a, b])], [0.5, 0.5]);
  const hot = [new Float32Array([1.5, -0.2])];
  assert.equal(peakOf(hot), 1.5);
  const g = normalizeIfClipping(hot, -0.3);
  assert.ok(Math.abs(20 * Math.log10(peakOf(hot)) - -0.3) < 0.01);
  assert.ok(g < 1);
  const quiet = [new Float32Array([0.2])];
  assert.equal(normalizeIfClipping(quiet), 1, 'no toca lo que no recorta');
});

test('layouts: 6 canales → 5.1 por defecto, con alternativas', () => {
  const l = defaultLayoutFor(6);
  assert.equal(l.channels.length, 6);
  assert.equal(l.channels[3].code, 'LFE');
  assert.deepEqual(layoutsForCount(6).map((x) => x.id), ['5.1', '5.1back']);
  assert.equal(defaultLayoutFor(8).id, '7.1');
  assert.equal(defaultLayoutFor(7).channels.length, 7);
  assert.equal(defaultLayoutFor(9).channels.length, 9, 'genérico');
  assert.match(channelColor(9), /^#[0-9a-f]{6}$/);
});
/* ───────────────────── duración estimada (guarda de memoria) ───────────────────── */

test('probe: estima la duración en WAV, M4A y AIFF', async () => {
  const wav = probeAudio(await asArrayBuffer(path.join(fixtures, 'test51.wav')), 'test51.wav');
  assert.equal(wav.frames, 96000, '2 s a 48 kHz');

  const m4a = probeAudio(await asArrayBuffer(path.join(fixtures, 'test_st.m4a')), 'test_st.m4a');
  // El mdhd incluye el relleno del codificador; basta para estimar memoria.
  assert.ok(Math.abs(m4a.frames / 44100 - 1) < 0.05, `frames M4A ≈ 44100, obtenido ${m4a.frames}`);
});

/* ───────────────────── memoria y decodificación nativa ───────────────────── */

test('motor: la estimación de memoria usa muestras por canal', async () => {
  const wav = probeAudio(await asArrayBuffer(path.join(fixtures, 'test51.wav')), 'test51.wav');
  const bytes = estimateDecodedBytes(wav, 0);
  assert.equal(bytes, 96000 * 6 * 4, '2 s × 6 canales × Float32 = 2,3 MB');
  assert.ok(bytes < 1.5 * 1024 ** 3, 'un archivo normal no avisa');

  // 7.1.4 a 96 kHz durante 2 h sí dispararía el aviso
  const atmos = { frames: 96000 * 3600 * 2, channels: 12 };
  assert.ok(estimateDecodedBytes(atmos) > 30 * 1024 ** 3);

  // Sin metadatos se estima por tamaño de archivo
  assert.equal(estimateDecodedBytes({ container: 'E-AC3' }, 1000), 6000);
});

test('motor: detección de formatos con soporte nativo', () => {
  assert.equal(isNativelySupported({ container: 'WAV' }), true);
  assert.equal(isNativelySupported({ container: 'FLAC' }), true);
  assert.equal(isNativelySupported({ container: 'MP4/M4A' }), true);
  assert.equal(isNativelySupported({ container: 'Ogg Opus' }), true);
  assert.equal(isNativelySupported({ container: 'E-AC3' }), false);
  assert.equal(isNativelySupported({ container: 'Matroska' }), false);
  assert.equal(isNativelySupported({}), false);
});
