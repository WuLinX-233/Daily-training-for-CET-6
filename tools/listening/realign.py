# -*- coding: utf-8 -*-
"""把 listening.json 里每句的 a/b（以及 qAt）平移回真正的位置。

## 为什么需要这一步

`build.py` 当初是这样定切片起点的：

    start = g_start - dur_t - LEAD_IN          # g_start 来自包络的「停顿分组」
    a     = T[idx][0] - T[i0][0] + LEAD_IN     # T 是上游给的绝对时间轴

代码假设 `g_start` 恰好等于「原文最后一句在音频里的结束位置」，于是
`off = g_start - T[i1][1]` 本该为 0。实测 77 段 **没有一段为 0**（中位数 +12.6 秒），
也就是这个假设不成立：`g_start` 落在原文结束之后十来秒（念题区里），
切片起点因此整体后移，而 a/b 仍按「切片从首句前 10 秒开始」计算 ——
结果就是**每一句都晚了大约 off 秒**，听起来完全对不上。

## 怎么修

`a/b/qAt` 统一减掉 `off`。这个量是结构性的（不是拟合出来的），
在 56 段上实测残差 0.05–0.25 秒。剩下 21 段（2025-06-1 / 2023-12-1 / 2023-12-2）
的切片起点错得太远，音频里根本不是那一段内容，只能重新切 —— 本脚本会把它们标出来，
不动它们的数据。

用法：
    python tools/listening/realign.py            # 改 listening.json
    python tools/listening/realign.py --dry      # 只看报告
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ENV = os.path.join(ROOT, '_build', 'env_fine.json')
STEP = 0.05


def prefix(a):
    p = [0.0]
    for v in a:
        p.append(p[-1] + v)
    return p


def mean_env(p, t0, t1, n):
    i = max(0, int(round(t0 / STEP)))
    j = min(n, int(round(t1 / STEP)))
    return None if j <= i else (p[j] - p[i]) / (j - i)


def quality(e, p, n, d):
    """线内平均能量 / 线间空隙平均能量。越大越说明对齐了（空隙应当是静音）。

    修正之后首句会落到 0 甚至略微为负（切片本来就没留引子，不是数据错），
    所以这里按 [0, dur] 夹一下再算；整句都落在音频外的（切片把它切掉了）
    跳过不参与评分，但要求 85% 以上的句子仍然有效。
    """
    ins = ing = 0.0
    ni = ng = 0
    skipped = 0
    dur = n * STEP
    L = e['lines']
    for k, ln in enumerate(L):
        a2, b2 = ln['a'] + d, ln['b'] + d
        if b2 <= 0 or a2 >= dur:
            skipped += 1
            continue
        m = mean_env(p, max(0.0, a2), min(dur, b2), n)
        if m is None:
            skipped += 1
            continue
        ins += m
        ni += 1
        if k + 1 < len(L):
            g0, g1 = max(0.0, b2), min(dur, L[k + 1]['a'] + d)
            if g1 - g0 >= 0.30:
                mg = mean_env(p, g0, g1, n)
                if mg is None:
                    continue
                ing += mg
                ng += 1
    if not ni or not ng or skipped > len(L) * 0.15:
        return 0.0
    return (ins / ni) / (ing / ng + 1e-6)


def main():
    dry = '--dry' in sys.argv
    lst = json.load(open(os.path.join(ROOT, 'listening.json'), encoding='utf-8'))
    plan = json.load(open(os.path.join(HERE, 'plan.json'), encoding='utf-8'))
    off = {e['audio']: e['meta']['off'] for e in plan}

    if not os.path.exists(ENV):
        sys.exit('缺少 %s，先跑 node tools/listening/env_fine.js' % ENV)
    env = json.load(open(ENV, encoding='utf-8'))

    fixed, recut = [], []
    print('%-38s %8s %7s %7s %7s' % ('audio', 'off', 'R前', 'R后', 'Δ'))
    for e in lst:
        fr = env[e['audio']]['env']
        n = len(fr)
        p = prefix(fr)
        o = off.get(e['audio'])
        if o is None:
            recut.append((e, 'plan.json 里没有'))
            continue
        before = quality(e, p, n, 0.0)
        if abs(o) >= 20:
            recut.append((e, 'off=%.1f，切片起点错太远' % o))
            print('%-38s %8.1f %7.2f %7s %7s  ← 需重切' % (e['audio'].split('/')[-1], o, before, '-', '-'))
            continue
        d = -o
        after = quality(e, p, n, d)
        print('%-38s %8.2f %7.2f %7.2f %7.2f' % (e['audio'].split('/')[-1], o, before, after, d))
        if after < 3.0:
            recut.append((e, '平移后 R=%.2f 仍然不达标' % after))
            continue
        fixed.append((e, d))

    if not dry:
        for e, d in fixed:
            for ln in e['lines']:
                ln['a'] = round(max(0.0, ln['a'] + d), 2)
                ln['b'] = round(max(0.05, ln['b'] + d), 2)
            e['qAt'] = round(max(0.05, e['qAt'] + d), 2)
        json.dump(lst, open(os.path.join(ROOT, 'listening.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        print('\n已写回 listening.json：修正 %d 段' % len(fixed))
    else:
        print('\n[dry] 可修正 %d 段' % len(fixed))

    if recut:
        print('\n需要重新切音频的 %d 段：' % len(recut))
        for e, why in recut:
            print('  %-40s %s' % (e['audio'].split('/')[-1], why))


if __name__ == '__main__':
    main()
