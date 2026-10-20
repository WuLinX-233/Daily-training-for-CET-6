# -*- coding: utf-8 -*-
"""带 Range 支持的多线程静态服务器，给 headless Chrome 取音频用。"""
import os, sys, functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8123


class H(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    handler = functools.partial(H, directory=ROOT)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), handler)
    srv.daemon_threads = True
    print('serving %s on %d' % (ROOT, PORT), flush=True)
    srv.serve_forever()
