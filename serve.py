#!/usr/bin/env python3
"""Servidor estático de desarrollo con cabeceras anti-caché.

    python3 serve.py [puerto]

Equivale a `python3 -m http.server` pero con `Cache-Control: no-store`, lo que
resulta muy cómodo mientras se develops la página.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.eac3': 'audio/eac3',
        '.m4a': 'audio/mp4',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = partial(NoCacheHandler, directory='.')
    print(f'▸ Divisor de canales en http://localhost:{port}')
    ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()