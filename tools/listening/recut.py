# -*- coding: utf-8 -*-
"""用上游时间轴直接重切指定套卷的听力音频。

## 为什么不用原来的切法

`build.py` 用包络里「停顿分组」的起点 `g_start` 反推切片起点：

    start = g_start - dur_t - LEAD_IN

这要求 `g_start` 正好等于原文最后一句在音频里的结束位置，实测并不成立
（偏差中位数 +12.6 秒），于是切片起点整体后移，句子时间轴也跟着错位。
少数套卷错得更离谱（偏 60–385 秒），切出来的音频里根本不是那一段内容，
只靠平移时间轴救不回来 —— 这类必须重切。

## 这次怎么切

上游 `timestamps.json` 给的绝对时间轴 T 本身是准的（在 56 段上平移后残差 0.05–0.25 秒
可以证明），所以直接：

    start_k = T[本段首句][0] - LEAD_IN
    end_k   = start_{k+1}          （最后一段取源音频结尾）
    a/b/qAt = T - T[本段首句][0] + LEAD_IN

完全不碰包络，也就没有 `off` 这个坑。切完 7 段首尾相接，既不重叠也不留缝。

用法：
    python tools/listening/recut.py 2023-12-1 2023-12-2 2025-06-1
    node tools/listening/cut.js 2023-12-1     # 再按新的 start/end 切片
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
LEAD_IN = 10.0
SECTIONS = ['Conversation One', 'Conversation Two', 'Passage One', 'Passage Two',
            'Recording One', 'Recording Two', 'Recording Three']


def repair(T):
    """与 build.py 里同名函数一致：修掉时长异常/逆序的时间条目。"""
    ds = sorted(b - a for a, b in T if 0.3 <= b - a <= 30)
    m = ds[len(ds) // 2] if ds else 3.0
    out = []
    for i, (a, b) in enumerate(T):
        d = b - a
        if d <= 0 or d > 30:
            a = out[i - 1][1] if (i > 0 and 0 <= b - out[i - 1][1] <= 30) else max(0.0, b - m)
        out.append([a, b])
    for i in range(1, len(out)):
        out[i][0] = max(out[i][0], out[i - 1][0])
        out[i][1] = max(out[i][1], out[i][0])
    return out


def main():
    targets = sys.argv[1:]
    if not targets:
        sys.exit('用法：python tools/listening/recut.py <setId> [setId ...]')

    ts = json.load(open(os.path.join(HERE, 'timestamps.json'), encoding='utf-8'))
    plan = json.load(open(os.path.join(HERE, 'plan.json'), encoding='utf-8'))
    lst = json.load(open(os.path.join(ROOT, 'listening.json'), encoding='utf-8'))
    plan_by = {(e['setId'], e['section']): e for e in plan}
    lst_by = {(e['setId'], e['title'].split('·')[-1].strip()): e for e in lst}

    for sid in targets:
        y, m, s = sid.split('-')
        T = repair(ts['cet6_%s.%s_set%s' % (y, m, s)])
        lines = json.load(open(os.path.join(ROOT, 'listen', sid + '.json'),
                               encoding='utf-8'))['lines']
        assert len(T) == len(lines), '%s 句数不符 %d vs %d' % (sid, len(T), len(lines))

        envd = json.load(open(os.path.join(HERE, 'env', sid + '.json'), encoding='utf-8'))
        src_dur = envd['dur']

        spans, i = [], 0
        while i < len(lines):
            sec = lines[i]['section']
            j = i
            while j < len(lines) and lines[j]['section'] == sec:
                j += 1
            spans.append((sec, i, j - 1))
            i = j
        assert [x[0] for x in spans] == SECTIONS, '%s 章节异常 %s' % (sid, [x[0] for x in spans])

        starts = [max(0.0, T[i0][0] - LEAD_IN) for _, i0, _ in spans]
        for k, (sec, i0, i1) in enumerate(spans):
            start = starts[k]
            end = starts[k + 1] if k + 1 < len(starts) else src_dur
            assert end - start > 30, '%s %s 区间太短 %.1f' % (sid, sec, end - start)
            qAt = round(T[i1][1] - T[i0][0] + LEAD_IN, 2)
            # 最后一段偶尔会「时间轴比音频还长」（上游那一版的录音短了几秒），
            # 这时把 qAt 和越界的句尾夹回音频末尾，宁可末尾一两句截断，也不要越界崩掉
            span = end - start
            clipped = 0
            if qAt > span - 0.2:
                qAt = round(span - 0.2, 2)
                clipped = sum(1 for idx in range(i0, i1 + 1)
                              if T[idx][1] - T[i0][0] + LEAD_IN > qAt)

            pe = plan_by[(sid, sec)]
            pe['start'] = round(start, 2)
            pe['end'] = round(end, 2)
            pe['dur'] = round(span, 2)
            pe['qAt'] = qAt

            le = lst_by[(sid, sec)]
            for idx in range(i0, i1 + 1):
                ln = le['lines'][idx - i0]
                ln['a'] = round(min(T[idx][0] - T[i0][0] + LEAD_IN, qAt - 0.05), 2)
                ln['b'] = round(min(T[idx][1] - T[i0][0] + LEAD_IN, qAt), 2)
            le['qAt'] = qAt
            le['dur'] = round(span, 2)

            print('%-12s %-18s start=%8.2f end=%8.2f dur=%7.2f qAt=%7.2f 句数=%d%s'
                  % (sid, sec, start, end, span, qAt, i1 - i0 + 1,
                     ('  [末尾截断 %d 句]' % clipped) if clipped else ''))

    json.dump(plan, open(os.path.join(HERE, 'plan.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    json.dump(lst, open(os.path.join(ROOT, 'listening.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('\n已更新 plan.json 与 listening.json。接着跑：')
    for sid in targets:
        print('  node tools/listening/cut.js %s' % sid)


if __name__ == '__main__':
    main()
