# -*- coding: utf-8 -*-
"""并行 Range 下载上游 12 套听力源音频（media.githubusercontent.com LFS 端点）。"""
import os, sys, json, time, threading, urllib.request

REPO = 'Ysoseri1224/CET-6-Listening-10-Years-Resources-and-Analysis'
BASE = 'https://media.githubusercontent.com/media/%s/main/' % REPO
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src')
os.makedirs(OUT, exist_ok=True)

SETS = [
    ('2023-06-1', 'CET6_2023.06/CET6_2023.06_set1_listening.mp3'),
    ('2023-06-2', 'CET6_2023.06/CET6_2023.06_set2_listening.mp3'),
    ('2023-12-1', 'CET6_2023.12/CET6_2023.12_set1_listening.mp3'),
    ('2023-12-2', 'CET6_2023.12/CET6_2023.12_set2_listening.mp3'),
    ('2024-06-1', 'CET6_2024.06/CET6_2024.06_set1_listening.mp3'),
    ('2024-06-2', 'CET6_2024.06/CET6_2024.06_set2_listening.mp3'),
    ('2024-12-1', 'CET6_2024.12/CET6_2024.12_set1_listening.mp3'),
    ('2024-12-2', 'CET6_2024.12/CET6_2024.12_set2_listening.mp3'),
    ('2025-06-1', 'CET6_2025.06/CET6_2025.06_set1_listening.mp3'),
    ('2025-06-2', 'CET6_2025.06/CET6_2025.06_set2_listening.mp3'),
    ('2025-12-1', 'CET6_2025.12/CET6_2025.12_set1_listening.mp3'),
    ('2025-12-2', 'CET6_2025.12/CET6_2025.12_set2_listening.mp3'),
]

CHUNK = 2 * 1024 * 1024
WORKERS = 8
UA = {'User-Agent': 'Mozilla/5.0'}


def head(url):
    req = urllib.request.Request(url, method='HEAD', headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers['Content-Length'])


def fetch_range(url, a, b, tries=6):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=dict(UA, Range='bytes=%d-%d' % (a, b)))
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            if len(data) == b - a + 1:
                return data
            print('  短包 %d/%d，重试' % (len(data), b - a + 1), flush=True)
        except Exception as e:
            print('  分片 %d-%d 第%d次失败: %s' % (a, b, k + 1, e), flush=True)
            time.sleep(1.5 * (k + 1))
    raise RuntimeError('分片下载失败 %d-%d' % (a, b))


def one(sid, path):
    url = BASE + path
    dst = os.path.join(OUT, sid + '.mp3')
    size = head(url)
    if os.path.exists(dst) and os.path.getsize(dst) == size:
        print('[%s] 已存在，跳过 %d B' % (sid, size), flush=True)
        return sid, size
    print('[%s] %d B (%.1f MB)' % (sid, size, size / 1048576), flush=True)
    chunks = [(a, min(a + CHUNK - 1, size - 1)) for a in range(0, size, CHUNK)]
    with open(dst, 'wb') as f:
        f.truncate(size)
    lock = threading.Lock()
    done = [0]
    err = []

    def work(pair):
        if err:
            return
        a, b = pair
        try:
            data = fetch_range(url, a, b)
            with lock:
                with open(dst, 'r+b') as f:
                    f.seek(a)
                    f.write(data)
                done[0] += len(data)
        except Exception as e:
            err.append(e)

    idx = [0]
    idx_lock = threading.Lock()

    def worker():
        while True:
            with idx_lock:
                if idx[0] >= len(chunks):
                    return
                i = idx[0]
                idx[0] += 1
            work(chunks[i])

    ths = [threading.Thread(target=worker) for _ in range(WORKERS)]
    t0 = time.time()
    for t in ths:
        t.start()
    last = 0
    while any(t.is_alive() for t in ths):
        time.sleep(2)
        p = done[0] / size * 100
        if p - last >= 20:
            last = p
            print('   %5.1f%%  %.0f KB/s' % (p, done[0] / 1024 / max(time.time() - t0, 1)), flush=True)
    for t in ths:
        t.join()
    if err:
        raise err[0]
    got = os.path.getsize(dst)
    assert got == size, '大小不符 %d != %d' % (got, size)
    print('[%s] 完成 %.1f MB  %.0fs' % (sid, size / 1048576, time.time() - t0), flush=True)
    return sid, size


if __name__ == '__main__':
    only = sys.argv[1:] or None
    t0 = time.time()
    meta = {}
    for sid, path in SETS:
        if only and sid not in only:
            continue
        s, n = one(sid, path)
        meta[s] = n
    with open(os.path.join(OUT, 'sizes.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    print('全部完成 %.1f 分钟，共 %.1f MB' % ((time.time() - t0) / 60,
          sum(meta.values()) / 1048576))
