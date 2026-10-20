#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CET-6 每日训练 —— 本地预览服务器

为什么不用 `python -m http.server`？
  自带的那个不支持 HTTP Range 请求。听力 mp3 有三四十分钟、4~5MB，
  不支持 Range 的话拖动进度条会卡住、部分手机浏览器干脆不播。
  这里补上 Range 支持（206 Partial Content），行为和 GitHub Pages 一致。

用法：双击 start-server.bat，或在本目录执行  python server.py [端口]
"""

import http.server
import os
import re
import socket
import socketserver
import sys

PORT = 8000
if len(sys.argv) > 1 and sys.argv[1].isdigit():
    PORT = int(sys.argv[1])


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'          # 支持 keep-alive，音视频拖动更顺

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if not self._serve_range():
            super().do_GET()

    def do_HEAD(self):
        if not self._serve_range(head=True):
            super().do_HEAD()

    def _serve_range(self, head=False):
        """有 Range 头且文件存在 → 返回 206；否则返回 False 交给父类"""
        rng = self.headers.get('Range')
        if not rng:
            return False

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return False

        m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
        if not m:
            return False

        size = os.path.getsize(path)
        start_s, end_s = m.group(1), m.group(2)
        if start_s == '' and end_s == '':          # bytes=- 无意义
            return False

        if start_s == '':                          # bytes=-500 最后 500 字节
            length = min(int(end_s), size)
            start = size - length
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1

        if start >= size:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return True

        end = min(end, size - 1)
        length = end - start + 1

        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Content-Length', str(length))
        self.end_headers()

        if head:
            return True
        with open(path, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
        return True

    def log_message(self, fmt, *args):
        # 只在出错时打印，正常请求不刷屏
        if args and str(args[1]).startswith(('4', '5')):
            sys.stderr.write('  %s - %s\n' % (self.address_string(), fmt % args))


def lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))             # 不会真的发包，只为拿到出口网卡 IP
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    if not ips:
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if not ip.startswith('127.') and ip not in ips:
                    ips.append(ip)
        except Exception:
            pass
    return ips


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True

    line = '=' * 52
    print(line)
    print('  CET-6 每日训练 · 本地服务')
    print(line)
    print()
    print('  [电脑]  http://localhost:%d' % PORT)
    for ip in lan_ips():
        print('  [手机]  http://%s:%d' % (ip, PORT))
    print()
    print('  手机要和电脑连同一个 WiFi；连不上就检查 Windows 防火墙。')
    print('  按 Ctrl+C 或关掉窗口停止服务。')
    print(line)
    print()

    try:
        with socketserver.ThreadingTCPServer(('0.0.0.0', PORT), RangeHandler) as httpd:
            httpd.serve_forever()
    except OSError as e:
        print('启动失败：%s' % e)
        print('端口 %d 可能被占用了，试试  python server.py 8080' % PORT)
        input('按回车退出…')


if __name__ == '__main__':
    main()
