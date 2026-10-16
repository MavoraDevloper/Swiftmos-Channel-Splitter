# Swiftmos - Channel Splitter

Página web para **abrir un archivo de audio y guardar cada canal por separado**.
Un 5.1 se convierte en seis WAV/FLAC/MP3 (L, R, C, LFE, SL, SR), un 7.1 en ocho,
un Atmos 7.1.4 en doce… y también al revés: puedes agrupar canales (por ejemplo
extraer el centro o los fronts en un solo archivo).

**Todo se procesa en el navegador.** Ningún archivo se sube a internet.

![Funcionamiento](https://img.shields.io/badge/privacidad-100%25%20local-34d399) ![Sin dependencias](https://img.shields.io/badge/dependencias-0-6366f1)

---

## Cómo se usa

1. Abre `index.html` en un navegador moderno (o lanza el servidor local, ver abajo).
2. Pulsa **Seleccionar archivo** (o arrastra el audio encima). También puedes
   cargar varios archivos a la vez.
3. Escucha canal a canal con **S** (solo), comprueba los niveles y la forma de
   onda de cada uno.
4. Elige formato, frecuencia y patrón de nombre, y pulsa **Exportar canales**.
   Todo se descarga en un único `.zip` o en archivos sueltos.

### Atajos de teclado

| Tecla | Acción |
|-------|--------|
| `Espacio` | Reproducir / pausar |
| `1`–`9` | Aislar ese canal (solo) |
| `0` | Escuchar todos los canales |
| `Esc` | Quitar el aislamiento |
| `←` / `→` | Retroceder / avanzar 5 s |

---

## Formatos

**Entrada** (lectura): todo lo que el navegador pueda decodificar — FLAC, WAV,
AIFF, M4A/AAC, MP3, Ogg Vorbis/Opus — más, mediante un motor de transcodificación
en WebAssembly que se carga solo si hace falta, los que no: **E-AC3, AC-3, DTS,
TrueHD, APE, WMA, MKA** y demás.

**Salida**: WAV 16/24 bits, WAV 32 bits float, FLAC, MP3 320/192, Opus, AAC
(M4A o ADTS), E-AC3 y AC-3.

> El motor de transcodificación (~30 MB) se descarga de un CDN la primera vez
> que hace falta y solo si lo necesitas. Todo lo demás —leer FLAC/WAV/M4A y
> escribir WAV— usa la Web Audio API sin descargar nada. Si no hay red, la app
> sigue funcionando con WAV.

---

## Detalles técnicos

### La frecuencia de muestreo no se degrada

`AudioContext.decodeAudioData()` **remuestrea a la frecuencia del contexto**, así
que un archivo de 96 kHz abierto en un contexto de 48 kHz perdería calidad sin
avisar. `js/probe.js` lee la cabecera del archivo (RIFF/WAVE, FLAC, AIFF, Ogg,
ISO-BMFF y tramas MPEG) y crea el contexto de decodificación **con la frecuencia
nativa** del archivo.

El orden de los canales se toma tal cual viene en el búfer decodificado, que es
exactamente el que usan FFmpeg y RIFF WAVE (orden `L R C LFE BL BR SL SR`).

### Exportar

- **WAV** se escribe en JavaScript (`js/wav-encoder.js`): sin dependencias,
  con dither TPDF opcional al bajar a 16 bits y normalización opcional a
  −0,3 dBFS para evitar recorte.
- **FLAC/MP3/Opus/AAC…** se recodifican desde un WAV intermedio con el motor.
- **ZIP** (`js/zip.js`) se escribe a mano, con DEFLATE mediante
  `CompressionStream('deflate-raw')` cuando el navegador lo soporta.

### Escucha por canal

Cada canal tiene su propia ganancia y su `AnalyserNode` para el vúmetro, y se
coloca en el estéreo de salida según su posición en la distribución:

| Canal | Salida |
|-------|--------|
| Central (`C`, `FC`) y `LFE` | ambos lados (mono, centrado) |
| Frontal/surround izquierdo (`L`, `FL`, `BL`, `SL`, `LTF`…) | solo izquierda |
| Frontal/surround derecho (`R`, `FR`, `BR`, `SR`, `RTF`…) | solo derecha |

Así se escucha la imagen espacial real: el diálogo en el centro, el plano a los
lados y los surrounds hacia atrás. El aislamiento (solo) y el silencio por canal
son `AudioParam` automatizables, así que no hay saltos al cambiar de canal.

> El `ChannelSplitterNode` entrega las señales en **mono**. Subirlas tal cual a
> un bus con `channelInterpretation: 'discrete'` las dejaría todas en el canal 0
> (FL) y sonarían únicamente por la izquierda. Por eso cada canal se convierte
> en un par estéreo (ganancia 1 en L y/o R) antes de sumar al bus.

Si el archivo tiene más de dos canales, la salida arranca en `1/√N` para que la
suma de todos ellos no sature; se ajusta con el control **Salida**.

### Estructura

```
index.html              Maquetación
css/styles.css          Estilos (tema claro y oscuro)
js/main.js              Interfaz y flujo de exportación
js/audio-engine.js      Decodificación, monitor de canales, remuestreo
js/probe.js             Lectura de cabeceras (frecuencia, canales, bits)
js/wav-encoder.js       Codificador WAV 16/24/32 float
js/zip.js               Escritor ZIP (store + deflate)
js/ffmpeg.js            Carga perezosa del motor de transcodificación
js/channel-layouts.js   Distribuciones y nombres de canales
js/utils.js             Formato, nombres de archivo, mezcla, normalización
tests/core.test.mjs     Pruebas con node:test
serve.py                Servidor local de desarrollo (sin caché)
```

---

## Desarrollo

```bash
npm start          # o:  python3 serve.py 8080
npm test           # pruebas unitarias (necesitan ffmpeg/ffprobe en el PATH)
```

Las pruebas validan los WAV y los ZIP generados **contra `ffprobe`, `unzip` y
`zipfile`**, y las cabeceras contra archivos reales de 5.1, 7.1, E-AC3, M4A y
MP2.

> No hace falta compilar nada: son módulos ES nativos. Para abrirlo sin servidor
> también funciona `file://`, salvo que quieras usar los formatos comprimidos
> (algunos navegadores exigen origen HTTP para los workers).