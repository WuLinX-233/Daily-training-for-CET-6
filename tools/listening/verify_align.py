# -*- coding: utf-8 -*-
"""逐句核对：句子里到底有没有声音、句与句之间的空隙是不是真的安静。

判据用「句内平均能量 / 句间空隙平均能量」（下称 R）：
  - 错位时 R ≈ 1，因为句窗和空隙窗里能量差不多（都在随机位置上）
  - 对齐后 R 会跳到 4–20，因为空隙真的是停顿
这比「句内语音覆盖率」判别力强得多 —— 覆盖率在两种情况下都能到 0.7 左右，分不开。

用法：python tools/listening/verify_align.py
需要先跑 node tools/listening/env_fine.js 生成 _build/env_fine.json。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ENV = os.path.join(ROOT, '_build', 'env_fine.json')
STEP = 0.05
GATE = 3.0


def prefix(a):
    p = [0.0]
    for v in a:
        p.append(p[-1] + v)
    return p


def mean_env(p, t0, t1, n):
    i = max(0, int(round(t0 / STEP)))
    j = min(n, int(round(t1 / STEP)))
    return None if j <= i else (p[j] - p[i]) / (j - i)


def ratio(e, p, n):
    ins = ing = 0.0
    ni = ng = 0
    dur = n * STEP
    L = e['lines']
    for k, ln in enumerate(L):
        m = mean_env(p, max(0.0, ln['a']), min(dur, ln['b']), n)
        if m is not None:
            ins += m
            ni += 1
        if k + 1 < len(L):
            g0, g1 = max(0.0, ln['b']), min(dur, L[k + 1]['a'])
            if g1 - g0 >= 0.30:
                mg = mean_env(p, g0, g1, n)
                if mg is not None:
                    ing += mg
                    ng += 1
    if not ni or not ng:
        return 0.0
    return (ins / ni) / (ing / ng + 1e-6)


def main():
    if not os.path.exists(ENV):
        sys.exit('缺少 %s，先跑 node tools/listening/env_fine.js' % ENV)
    env = json.load(open(ENV, encoding='utf-8'))
    lst = json.load(open(os.path.join(ROOT, 'listening.json'), encoding='utf-8'))

    rows = []
    for e in lst:
        fr = env[e['audio']]['env']
        rows.append((e['audio'].split('/')[-1], ratio(e, prefix(fr), len(fr)), e['setId']))

    rows.sort(key=lambda r: r[1])
    print('%-38s %8s %6s' % ('audio', 'R', '判定'))
    for name, r, _ in rows:
        print('%-38s %8.2f %6s' % (name, r, '✓' if r >= GATE else '✗'))

    ok = [r for r in rows if r[1] >= GATE]
    bad = [r for r in rows if r[1] < GATE]
    print('\n对齐正常 %d 段，仍错位 %d 段（门槛 R ≥ %.1f）' % (len(ok), len(bad), GATE))
    if bad:
        print('仍错位的套卷：', sorted({r[2] for r in bad}))
    sys.exit(0 if not bad else 1)


if __name__ == '__main__':
    main()
