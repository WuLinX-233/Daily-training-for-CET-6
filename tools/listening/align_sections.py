# -*- coding: utf-8 -*-
"""给「时间轴被压缩」的那几套重新对齐句子时间轴（逐句 DP 匹配）。

## 为什么平移不够

`2023-12-1` / `2023-12-2` / `2025-06-1` 这三套，上游时间轴相对音频是**压缩的** ——
2025-06-1 的时间轴只覆盖 1122 秒，音频却有 1580 秒，少算了 458 秒（大量作答停顿没计入）。
既然是「缺停顿」而不是「整体偏移」，任何单一平移量都救不回来。

## 怎么对齐

音频结构非常规整，可以直接读出来：
- 每套 7 个分节，分节之间的作答停顿**每个都是 13.3–13.8 秒**，3–4 个连成一簇
- 所以：一簇 13 秒停顿 = 一个分节的结尾；分节区间 = [上一簇结束, 本簇结束]
- 分节内，第一段 ≥8 秒的停顿就是「原文念完、开始念题」的位置

剩下的问题：把 n 句文本对到分节里那一串语音段（50ms 包络切出来的发声区间）。
每句的**说话时长** d_i 是可信的（来自上游对齐），只是位置不可信。
于是做一次序列对齐：把相邻的若干语音段合成一组给一句，代价是「这组跨度 − d_i」，
再加一点「句间停顿过长」的惩罚，用 DP 求全局最优。开头那段 "Questions 1 to 4…"
引子和结尾念的题目会自然落成「没被分配的多余语音段」。

用法：
    node tools/listening/env_src.js 2023-12-1 2023-12-2 2025-06-1
    python tools/listening/align_sections.py --dry
    python tools/listening/align_sections.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ENV = os.path.join(ROOT, '_build', 'env_src.json')
STEP = 0.05
LEAD_IN = 10.0
GAP_PENALTY = 0.6          # 每超出一秒多余停顿的代价
GAP_FREE = 5.0             # 句间停顿在这个长度内不罚
MAX_GAP = 6.0              # 句间停顿的硬上限：原文内部不会有更长的静默
MIN_PAUSE = 0.30           # 句界必须落在这么长的静音里（真实停顿的最短长度）
BOUND_W = 2.0              # 句界落在连续语音中间的罚分
THRS = (0.02, 0.03, 0.045)                    # 发声阈值的候选（占峰值比例）
S_GRID = [round(0.9 + 0.1 * i, 2) for i in range(14)]   # 时长缩放比 0.9..2.2
MIN_COV = 0.50             # 句内发声占比的下限，挡掉「塞进静音里」的假高分
END_TOL = 3.0              # 末句收尾离 t_end 最多允许差这么多秒
GATE = 3.0                 # R 的达标线，和 tools/listening/verify_align.py 一致
SECTIONS = ['Conversation One', 'Conversation Two', 'Passage One', 'Passage Two',
            'Recording One', 'Recording Two', 'Recording Three']
TARGETS = ['2023-12-1', '2023-12-2', '2025-06-1']


def repair(T):
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


def silence_runs(fr, thr, minlen, t0=0.0, t1=None):
    t1 = len(fr) * STEP if t1 is None else t1
    i0 = max(0, int(round(t0 / STEP)))
    i1 = min(len(fr), int(round(t1 / STEP)))
    out, st = [], -1
    for i in range(i0, i1):
        sil = fr[i] <= thr
        if sil and st < 0:
            st = i
        if (not sil or i == i1 - 1) and st >= 0:
            if (i - st) * STEP >= minlen:
                out.append((st * STEP, i * STEP))
            st = -1
    return out


def speech_runs(fr, thr, minlen, t0, t1):
    """[t0,t1) 里的发声段（静音段的补集）。"""
    i0 = max(0, int(round(t0 / STEP)))
    i1 = min(len(fr), int(round(t1 / STEP)))
    out, st = [], -1
    for i in range(i0, i1):
        on = fr[i] > thr
        if on and st < 0:
            st = i
        if (not on or i == i1 - 1) and st >= 0:
            if (i - st) * STEP >= minlen:
                out.append((st * STEP, i * STEP))
            st = -1
    return out


def dp_assign(runs, durs, end_min=None):
    """把 durs 逐句分配到 runs 的连续子区间，返回每句的 (start_idx, end_idx)。

    允许开头/结尾有没被分配的多余语音段（引子、念题）。
    句间停顿硬性限制在 MAX_GAP 秒内 —— 原文内部不会有更长的静默，
    长静默只出现在「原文结束/念题」处，这条约束把 DP 逼到正确的走法上。

    另外每条句界必须落在真实静音里（≥ MIN_PAUSE），否则罚 BOUND_W。
    没有这一条，DP 会把句子从连续语音中间硬切开 —— 因为那种切法同样能把
    「跨度 ≈ 时长」凑得很准，代价一样低。而音频开头那段「考试说明」是密不透风
    的连续说话，正好是最容易凑数的地方，于是整段文本被塞进说明里，R 惨不忍睹。

    end_min：末句结束不得早于这个时刻。原文最后一句念完就是作答停顿，
    所以末句的收尾必须贴着 t_end —— 这条把「整段文本塞进开头说明里」彻底堵死。
    """
    n, m = len(durs), len(runs)
    if not n or not m:
        return []
    INF = float('inf')

    def gap_before(s):
        return 0.0 if s == 0 else runs[s][0] - runs[s - 1][1]

    bpen = [0.0 if s == 0 else BOUND_W * max(0.0, MIN_PAUSE - gap_before(s))
            for s in range(m)]

    dp = [[INF] * m for _ in range(n)]
    back = [[-1] * m for _ in range(n)]
    pre = [[-1] * m for _ in range(n)]      # 上一句的结束段下标

    for j in range(m):
        best, bs = INF, -1
        for s in range(j + 1):
            c = abs((runs[j][1] - runs[s][0]) - durs[0]) + bpen[s]
            if c < best:
                best, bs = c, s
        dp[0][j] = best
        back[0][j] = bs

    for i in range(1, n):
        prev = dp[i - 1]
        # 先算「从哪个 s 进入本句」的最佳前缀代价。它只跟 s 有关、跟 j 无关，
        # 放到 j 循环外面算一次就够了（放在里面会让整个 DP 慢两个数量级）。
        ent = [INF] * m
        for s in range(1, m):
            bp, bpp = INF, -1
            for p in range(s - 1, -1, -1):
                g = runs[s][0] - runs[p][1]
                if g > MAX_GAP:
                    break
                c = prev[p]
                if c == INF:
                    continue
                c += GAP_PENALTY * max(0.0, g - GAP_FREE)
                if c < bp:
                    bp, bpp = c, p
            if bp < INF:
                ent[s] = bp + bpen[s]
                pre[i][s] = bpp
        for j in range(m):
            best, bs = INF, -1
            rj = runs[j][1]
            for s in range(1, j + 1):
                c = ent[s]
                if c == INF:
                    continue
                c += abs((rj - runs[s][0]) - durs[i])
                if c < best:
                    best, bs = c, s
            dp[i][j] = best
            back[i][j] = bs

    ends = [j for j in range(m) if end_min is None or runs[j][1] >= end_min]
    if not ends:
        ends = list(range(m))
    end = min(ends, key=lambda j: dp[n - 1][j])
    out = []
    for i in range(n - 1, -1, -1):
        s = back[i][end]
        out.append((s, end))
        if i:
            end = pre[i][s]
    return list(reversed(out))


def quality(fr, thr, spans):
    ins = ing = 0.0
    ni = ng = 0
    for k, (a, b) in enumerate(spans):
        i0 = max(0, int(round(a / STEP)))
        i1 = min(len(fr), int(round(b / STEP)))
        if i1 <= i0:
            continue
        ins += sum(fr[i0:i1]) / (i1 - i0)
        ni += 1
        if k + 1 < len(spans):
            g0, g1 = i1, max(i1, int(round(spans[k + 1][0] / STEP)))
            if g1 - g0 >= 6:
                ing += sum(fr[g0:g1]) / (g1 - g0)
                ng += 1
    if not ni or not ng:
        return 0.0
    return (ins / ni) / (ing / ng + 1e-6)


def coverage(fr, thr, spans):
    """每条线里「有声音」的帧占比，取中位数。

    防的是「把句子塞进静音里」这种刷分法：那样 R 会高得离谱（分母趋近 0），
    但对齐显然是错的。真实句子的跨度里大部分时间应该在说话。
    """
    v = []
    for a, b in spans:
        j0 = max(0, int(round(a / STEP)))
        j1 = min(len(fr), int(round(b / STEP)))
        if j1 <= j0:
            continue
        v.append(sum(1 for i in range(j0, j1) if fr[i] > thr) / (j1 - j0))
    v.sort()
    return v[len(v) // 2] if v else 0.0


def main():
    dry = '--dry' in sys.argv
    if not os.path.exists(ENV):
        sys.exit('缺少 %s，先跑 node tools/listening/env_src.js ...' % ENV)
    src = json.load(open(ENV, encoding='utf-8'))
    ts = json.load(open(os.path.join(HERE, 'timestamps.json'), encoding='utf-8'))
    plan = json.load(open(os.path.join(HERE, 'plan.json'), encoding='utf-8'))
    lst = json.load(open(os.path.join(ROOT, 'listening.json'), encoding='utf-8'))
    plan_by = {(e['setId'], e['section']): e for e in plan}
    lst_by = {(e['setId'], e['title'].split('·')[-1].strip()): e for e in lst}

    total_ok = total = 0
    for sid in TARGETS:
        key = '/tools/listening/src/%s.mp3' % sid
        if key not in src:
            print('[%s] 缺少包络，跳过' % sid)
            continue
        fr = src[key]['env']
        dur = src[key]['dur']
        thr = max(fr) * 0.03

        y, m, s = sid.split('-')
        T = repair(ts['cet6_%s.%s_set%s' % (y, m, s)])
        lines = json.load(open(os.path.join(ROOT, 'listen', sid + '.json'),
                               encoding='utf-8'))['lines']
        assert len(T) == len(lines), '%s 句数不符' % sid

        big = silence_runs(fr, thr, 2.0)
        cl = [[big[0]]]
        for r in big[1:]:
            if r[0] - cl[-1][-1][1] > 90:
                cl.append([r])
            else:
                cl[-1].append(r)
        assert len(cl) == 7, '%s 长停顿聚成 %d 簇' % (sid, len(cl))
        bounds = [0.0] + [c[-1][1] for c in cl] + [dur]

        spans, i = [], 0
        while i < len(lines):
            sec = lines[i]['section']
            j = i
            while j < len(lines) and lines[j]['section'] == sec:
                j += 1
            spans.append((sec, i, j - 1))
            i = j
        assert [x[0] for x in spans] == SECTIONS, '%s 章节异常' % sid

        print('=== %s ===' % sid)
        for k, (sec, i0, i1) in enumerate(spans):
            reg0, reg1 = bounds[k], bounds[k + 1]
            pauses = silence_runs(fr, thr, 8.0, reg0 + 15, reg1)
            t_end = pauses[0][0] if pauses else reg1 - 2.0
            # 只在「原文 + 第一题」这一截里找；再往后是 13 秒作答停顿隔开的念题，
            # 让 DP 跑过去也能拿到很高的 R（停顿是安静的），那是假高分
            durs = [T[idx][1] - T[idx][0] for idx in range(i0, i1 + 1)]
            # 上游时间轴是「压缩」的，整体偏短，所以除了位置还要估一个时长缩放比；
            # 另外发声阈值也很关键 —— 定得太高会把句子切碎成一堆 0.3 秒的小段，
            # DP 只能在碎段里挑，挑不到「整句」那个跨度（2023-12-1 Passage One
            # 就是换到 2% 才从 R=2.9 跳到 R=52）。两个维度一起粗搜，用 R 当目标。
            best = None
            for tf in THRS:
                t2 = max(fr) * tf
                rs = speech_runs(fr, t2, 0.25, reg0, t_end)
                if len(rs) < len(durs):
                    continue
                for S in S_GRID:
                    assign = dp_assign(rs, [d * S for d in durs], t_end - END_TOL)
                    cand = [(rs[a][0], rs[b][1]) for a, b in assign]
                    if coverage(fr, t2, cand) < MIN_COV:
                        continue
                    q = quality(fr, t2, cand)
                    if best is None or q > best[0]:
                        best = (q, tf, S, cand)
            if best is None:
                print('  %-18s 没找到可用对齐，跳过' % sec)
                continue
            q, tf, S, out = best
            total += 1
            ok = q >= GATE
            total_ok += ok
            print('  %-18s 段[%7.1f,%7.1f] 句数=%2d 末句止=%7.1f thr=%.3f S=%.1f R=%6.2f %s'
                  % (sec, reg0, reg1, len(durs), out[-1][1], tf, S, q, '✓' if ok else '✗'))

            if not dry:
                start = max(0.0, out[0][0] - LEAD_IN)
                pe = plan_by[(sid, sec)]
                pe['start'] = round(start, 2)
                pe['end'] = round(reg1, 2)
                pe['dur'] = round(reg1 - start, 2)
                pe['qAt'] = round(t_end - start, 2)
                le = lst_by[(sid, sec)]
                for n, idx in enumerate(range(i0, i1 + 1)):
                    ln = le['lines'][idx - i0]
                    ln['a'] = round(out[n][0] - start, 2)
                    ln['b'] = round(out[n][1] - start, 2)
                le['qAt'] = round(t_end - start, 2)
                le['dur'] = round(reg1 - start, 2)
        print()

    print('达标 %d / %d 段' % (total_ok, total))
    if not dry:
        json.dump(plan, open(os.path.join(HERE, 'plan.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        json.dump(lst, open(os.path.join(ROOT, 'listening.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        print('已写回 plan.json 与 listening.json。接着重切：')
        for sid in TARGETS:
            print('  node tools/listening/cut.js %s' % sid)


if __name__ == '__main__':
    main()
