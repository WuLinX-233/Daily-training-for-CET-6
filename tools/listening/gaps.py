# -*- coding: utf-8 -*-
"""从 1 秒 RMS 包络里找静音段、按停顿组分段，产出 84 个 section 的切点。"""
import json, os, sys, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, 'env')

SECTIONS = ['Conversation One', 'Conversation Two', 'Passage One', 'Passage Two',
            'Recording One', 'Recording Two', 'Recording Three']
# 每套 7 个 section 后面的停顿组大小（结构指纹）
FINGERPRINT = [4, 4, 3, 4, 3, 3, 4]

MIN_GAP = 4.0        # 短于这个的不算作答停顿
GROUP_SPLIT = 45.0   # 相邻停顿间隔超过这么多秒 → 换组


def load(sid):
    return json.load(open(os.path.join(ENV, sid + '.json'), encoding='utf-8'))


def find_gaps(env, thr, minlen=MIN_GAP):
    runs, i, n = [], 0, len(env)
    while i < n:
        if env[i] < thr:
            j = i
            while j < n and env[j] < thr:
                j += 1
            if j - i >= minlen:
                runs.append((float(i), float(j)))
            i = j
        else:
            i += 1
    return runs


def threshold(env):
    med = statistics.median(env)
    lo = sorted(env)[int(len(env) * 0.05)]
    hi = sorted(env)[int(len(env) * 0.95)]
    thr = lo + 0.12 * (hi - lo)
    return max(0.004, min(thr, 0.12 * med if med > 0 else thr))


def group(runs):
    if not runs:
        return []
    groups = [[runs[0]]]
    for g in runs[1:]:
        if g[0] - groups[-1][-1][1] > GROUP_SPLIT:
            groups.append([g])
        else:
            groups[-1].append(g)
    return groups


def report(sid):
    d = load(sid)
    env = d['env']
    thr = threshold(env)
    runs = find_gaps(env, thr)
    gs = group(runs)
    sizes = [len(g) for g in gs]
    ok = sizes[-7:] == FINGERPRINT
    print('%-11s dur %6.1fs  thr %.4f  静音段 %2d  分组 %s  %s' %
          (sid, d['dur'], thr, len(runs), sizes, '指纹OK' if ok else '指纹不符'))
    for g in gs[-7:] if len(gs) >= 7 else gs:
        print('     %s  段长 %s' % (
            ' '.join('%.0f-%.0f' % r for r in g),
            ' '.join('%.0f' % (b - a) for a, b in g)))
    return d, gs, ok


if __name__ == '__main__':
    ids = sys.argv[1:] or sorted(x[:-5] for x in os.listdir(ENV) if x.endswith('.json'))
    for sid in ids:
        report(sid)
        print()
