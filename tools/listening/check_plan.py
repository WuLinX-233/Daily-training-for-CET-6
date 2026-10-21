# -*- coding: utf-8 -*-
"""写回后的一致性检查：时间轴必须落在切片里、单调、句数与音频段对得上。"""
import json, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
TARGETS = ('2023-12-1', '2023-12-2', '2025-06-1')

plan = json.load(open(os.path.join(ROOT, 'tools', 'listening', 'plan.json'), encoding='utf-8'))
lst = json.load(open(os.path.join(ROOT, 'listening.json'), encoding='utf-8'))
pb = {(e['setId'], e['section']): e for e in plan}
lb = {(e['setId'], e['title'].split('·')[-1].strip()): e for e in lst}

bad = 0
for (sid, sec), p in sorted(pb.items()):
    if sid not in TARGETS:
        continue
    L = lb[(sid, sec)]
    d = p['dur']
    errs = []
    if abs((p['end'] - p['start']) - d) > 0.02:
        errs.append('dur 对不上')
    if p['qAt'] > d + 0.01:
        errs.append('qAt %.2f > dur %.2f' % (p['qAt'], d))
    prev = -1.0
    for i, ln in enumerate(L['lines']):
        if ln['a'] < -0.01 or ln['b'] > d + 0.01:
            errs.append('第 %d 句越界 %.2f-%.2f (dur %.2f)' % (i, ln['a'], ln['b'], d))
            break
        if ln['b'] <= ln['a']:
            errs.append('第 %d 句 b<=a' % i)
            break
        if ln['a'] < prev - 0.02:
            errs.append('第 %d 句起点回退 %.2f < %.2f' % (i, ln['a'], prev))
            break
        prev = ln['b']
    if L['lines'] and L['lines'][-1]['b'] > p['qAt'] + 0.5:
        errs.append('末句 %.2f 越过 qAt %.2f' % (L['lines'][-1]['b'], p['qAt']))
    n = len(L['lines'])
    print('%-11s %-18s start %7.2f dur %7.2f qAt %7.2f 句数 %2d 末句止 %7.2f %s'
          % (sid, sec, p['start'], d, p['qAt'], n, L['lines'][-1]['b'] if n else 0,
             'OK' if not errs else ' / '.join(errs)))
    if errs:
        bad += 1
print()
print('异常 %d 段' % bad)
sys.exit(1 if bad else 0)
