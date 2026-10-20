# -*- coding: utf-8 -*-
"""把 11 套 × 7 个 section 展开成 77 天的每日听力素材。

坐标模型（已用现有 12 段逐字节验证，误差 0）：
    T = getfine 仓库的句级时间轴（可能整体偏移、局部漂移）
    停顿组首段起点 = 原文结束（真实音频坐标）
    off = 停顿组首段起点 − T[末句][1]        ← 抵消整体偏移
    start = T[首句][0] + off − 10            ← 往前多留 10 秒，包住「Questions X to Y」引子
    end   = 停顿组末段终点 + 8.5
    qAt   = 原文结束 − start
时间轴内部漂移时（组间跨度校验超出 ±6 秒），用声学跨度反推真实时长并按比例缩放句时间。
"""
import json, os, re, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))   # cet6-app/
DATA = os.path.join(HERE, 'data')
ENV = os.path.join(HERE, 'env')

SECTIONS = ['Conversation One', 'Conversation Two', 'Passage One', 'Passage Two',
            'Recording One', 'Recording Two', 'Recording Three']
SLUG = {'Conversation One': 'conversationone', 'Conversation Two': 'conversationtwo',
        'Passage One': 'passageone', 'Passage Two': 'passagetwo',
        'Recording One': 'recordingone', 'Recording Two': 'recordingtwo',
        'Recording Three': 'recordingthree'}
FINGERPRINT = [4, 4, 3, 4, 3, 3, 4]
EXPECT = [None, 14, 43, 14, 40, 15, 15]   # 每个 section 前「停顿+报题/说明+停顿」的期望秒数
MIN_GAP, GROUP_SPLIT = 4.0, 45.0
LEAD_IN, TAIL = 10.0, 8.5

# 2025.06 第二套的录音把 25 个作答停顿剪掉了（1494.09 − 1156.30 = 337.8 ≈ 25×13.5），
# 分节边界无法可靠还原，整套排除。
SKIP = {'2025-06-2'}

# 新 → 旧，同一套内按考试顺序
ORDER = ['2025-12-1', '2025-12-2', '2025-06-1', '2024-12-1', '2024-12-2',
         '2024-06-1', '2024-06-2', '2023-12-1', '2023-12-2', '2023-06-1', '2023-06-2']

STOP = set('''a an the and or but nor so yet for of to in on at by with from into onto
about over under above below between among through during after before while as than then
is are was were be been being am do does did doing have has had having will would shall
should can could may might must not no nor none i you he she it we they me him her us them
my your his its our their mine yours hers ours theirs this that these those there here
what which who whom whose when where why how if whether because though although unless until
since both each either neither all any some no every much many more most less least few
other another such own same very too also just only even still already yet again ever never
always often sometimes usually up down out off away back forth again once twice
s t re ve ll d m don didn doesn isn aren wasn weren won wouldn couldn shouldn
oh well ok okay yeah yes right now then
'''.split())


# ---------- 静音结构 ----------
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
    s = sorted(env)
    lo, hi = s[int(len(env) * .05)], s[int(len(env) * .95)]
    med = statistics.median(env)
    thr = lo + 0.12 * (hi - lo)
    return max(0.004, min(thr, 0.12 * med if med > 0 else thr))


def group(runs):
    if not runs:
        return []
    gs = [[runs[0]]]
    for g in runs[1:]:
        if g[0] - gs[-1][-1][1] > GROUP_SPLIT:
            gs.append([g])
        else:
            gs[-1].append(g)
    return gs


# ---------- 时间轴修复 ----------
def repair(T):
    ds = sorted(b - a for a, b in T if 0.3 <= b - a <= 30)
    m = ds[len(ds) // 2] if ds else 3.0
    out, fixed = [], 0
    for i, (a, b) in enumerate(T):
        d = b - a
        if d <= 0 or d > 30:
            a = out[i - 1][1] if (i > 0 and 0 <= b - out[i - 1][1] <= 30) else max(0.0, b - m)
            fixed += 1
        out.append([a, b])
    for i in range(1, len(out)):
        out[i][0] = max(out[i][0], out[i - 1][0])
        out[i][1] = max(out[i][1], out[i][0])
    return out, fixed


# ---------- 题干 / 答案 ----------
def parse_stem(path):
    """题干文件是「题号. A) …」开头、B/C/D 各占一行的多行块，按题号切块再抓选项。"""
    txt = open(path, encoding='utf-8-sig').read().replace('\r\n', '\n')
    marks = list(re.finditer(r'^\s*(\d{1,2})\.\s*', txt, re.M))
    out = {}
    for i, m in enumerate(marks):
        body = txt[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(txt)]
        body = ' '.join(body.split())
        opts = re.findall(r'([A-D])\)\s*(.+?)(?=\s+[A-D]\)|$)', body)
        out[int(m.group(1))] = ['%s) %s' % (k, v.strip()) for k, v in opts]
    return out


def parse_ans(path):
    txt = open(path, encoding='utf-8-sig').read()
    return {int(a): b for a, b in re.findall(r'^\s*(\d{1,2})\.\s*([A-D])\s*$', txt, re.M)}


# ---------- 挖空 ----------
NOUN = re.compile(r'(ing|tion|sion|ment|ness|ity|ance|ence|ship|hood|ism|ist|er|or|ics'
                  r'|age|ure|al|ive|ous|able|ible|ful|less|ic|ary|ory|ent|ant)$', re.I)


def make_cloze(text):
    """挑一段 1–2 个实词作挖空。

    规则来自现有手做挖空的反推：偏好双词搭配、避开句首、避开 -ly 副词、
    避开句中大写（专有名词）、偏好句子后半；太短的句子宁可不挖。
    """
    toks = re.findall(r"[A-Za-z][A-Za-z'\-]*|[^A-Za-z]+", text)
    words = [(i, t) for i, t in enumerate(toks) if re.match(r'[A-Za-z]', t)]
    if len(words) < 6:            # 太短，挖了也没信息量
        return None
    n = len(words)
    best, best_sc = None, -1e9
    for wi in range(n):
        for k in (1, 2):
            if wi + k > n:
                break
            span = words[wi:wi + k]
            idx = [i for i, _ in span]
            if idx[-1] - idx[0] != k - 1:      # 中间夹了标点
                break
            ws = [t for _, t in span]
            if any(w.lower().strip("'-_") in STOP for w in ws):
                continue
            if any(len(w) < 3 for w in ws) or any("'" in w for w in ws):
                continue
            sc = sum(len(w) for w in ws) + 8 * (k - 1)
            if wi == 0:
                sc -= 2
            if any(w.lower().endswith('ly') for w in ws):
                sc -= 3
            if any(w[0].isupper() for w in ws):
                sc -= 4
            if wi >= n * 0.5:
                sc += 2
            if NOUN.search(ws[-1]):
                sc += 1
            if sc > best_sc:
                best, best_sc = span, sc
    if not best or best_sc < 8:
        return None
    a, b = best[0][0], best[-1][0]
    left = ''.join(toks[:a])
    right = ''.join(toks[b + 1:])
    if not left and not right:
        return None
    parts = []
    if left:
        parts.append(left)
    parts.append({'a': ''.join(toks[a:b + 1])})
    if right:
        parts.append(right)
    return parts


# ---------- 主流程 ----------
def main():
    ts = json.load(open(os.path.join(HERE, 'timestamps.json'), encoding='utf-8'))
    old = json.load(open(os.path.join(APP, 'listening.json'), encoding='utf-8'))
    old_map = {(e['setId'], e['title'].split('·')[-1].strip()): e for e in old}
    labels = {e['id']: e['label'] for e in json.load(
        open(os.path.join(APP, 'listen', 'index.json'), encoding='utf-8'))}

    plan, problems = [], []
    for sid in ORDER:
        if sid in SKIP:
            continue
        listen = json.load(open(os.path.join(APP, 'listen', sid + '.json'), encoding='utf-8'))
        lines = listen['lines']
        y, m, s = sid.split('-')
        T, fixed = repair(ts['cet6_%s.%s_set%s' % (y, m, s)])
        assert len(T) == len(lines), '%s 句数不符' % sid
        if fixed:
            print('  [%s] 修复 %d 个异常时间条目' % (sid, fixed))

        envd = json.load(open(os.path.join(ENV, sid + '.json'), encoding='utf-8'))
        gs = group(find_gaps(envd['env'], threshold(envd['env'])))
        if [len(g) for g in gs] != FINGERPRINT:
            problems.append('%s 停顿指纹不符 %s' % (sid, [len(g) for g in gs]))
            continue

        spans, i = [], 0
        while i < len(lines):
            sec = lines[i]['section']
            j = i
            while j < len(lines) and lines[j]['section'] == sec:
                j += 1
            spans.append((sec, i, j - 1))
            i = j
        assert [x[0] for x in spans] == SECTIONS, '%s 章节异常' % sid

        stem = parse_stem(os.path.join(DATA, '%s.%s_set%s_q_stem.txt' % (y, m, s)))
        ans = parse_ans(os.path.join(DATA, '%s.%s_set%s_q_answer.txt' % (y, m, s)))

        for k, (sec, i0, i1) in enumerate(spans):
            g = gs[k]
            g_start, g_end = g[0][0], g[-1][1]
            off = g_start - T[i1][1]
            dur_t = T[i1][1] - T[i0][0]
            dur = dur_t
            fixed_dur = False
            if k > 0:
                span = g_start - gs[k - 1][-1][1]
                if abs(span - dur_t - EXPECT[k]) > 6:
                    dur = span - EXPECT[k]
                    fixed_dur = True
            scale = dur / dur_t if dur_t else 1.0

            # 切点一律从「本组第一个停顿的起点」往前推，这样 qAt 与 start 必然自洽：
            # g_start − start = dur + LEAD_IN = qAt。用 T[i0][0]+off 算只在 dur==dur_t 时等价
            start = g_start - dur - LEAD_IN
            end = min(g_end + TAIL, envd['dur'] - 0.05)   # 最后一段别越界
            qAt = dur + LEAD_IN

            nums = sorted({n for l in lines[i0:i1 + 1] for n in (l.get('marks') or [])})
            qs = []
            for n in nums:
                at = next((idx - i0 for idx in range(i0, i1 + 1)
                           if n in (lines[idx].get('marks') or [])), 0)
                qs.append({'q': '', 'options': stem.get(n, []), 'answer': ans.get(n, ''),
                           'at': at})
                if len(qs[-1]['options']) != 4:
                    problems.append('%s %s Q%d 选项数 %d' % (sid, sec, n, len(qs[-1]['options'])))
                if not qs[-1]['answer']:
                    problems.append('%s %s Q%d 缺答案' % (sid, sec, n))

            olde = old_map.get((sid, sec))
            out_lines = []
            for idx in range(i0, i1 + 1):
                ln = lines[idx]
                a = (T[idx][0] - T[i0][0]) * scale + LEAD_IN
                b = (T[idx][1] - T[i0][0]) * scale + LEAD_IN
                b = min(b, qAt)
                item = {'sp': ln.get('speaker') or '', 't': ln['text'],
                        'zh': ln.get('zh', ''), 'a': round(a, 2), 'b': round(b, 2)}
                if ln.get('marks'):
                    item['marks'] = ln['marks']
                cz = None
                if olde:
                    for ol in olde['lines']:
                        if ol['t'] == ln['text'] and ol.get('cloze'):
                            cz = ol['cloze']
                            break
                if cz is None and (idx - i0) % 2 == 0:
                    cz = make_cloze(ln['text'])
                if cz:
                    item['cloze'] = cz
                out_lines.append(item)

            plan.append({
                'setId': sid, 'section': sec,
                'title': '%s · %s' % (labels[sid], sec),
                'audio': 'audio/seg/%s_%s.mp3' % (sid, SLUG[sec]),
                'start': round(start, 2), 'end': round(end, 2),
                'dur': round(end - start, 2), 'qAt': round(qAt, 2),
                'lines': out_lines, 'questions': qs,
                'meta': {'dur_t': round(dur_t, 2), 'dur_fix': fixed_dur,
                         'scale': round(scale, 4), 'off': round(off, 2),
                         'group': [list(x) for x in g]},
            })

    # 日期
    import datetime
    d0 = datetime.date(2026, 10, 19)
    for n, e in enumerate(plan):
        e['date'] = (d0 + datetime.timedelta(days=n)).isoformat()

    json.dump(plan, open(os.path.join(HERE, 'plan.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('\n段落 %d 条' % len(plan))
    print('问题 %d 项' % len(problems))
    for p in problems[:30]:
        print('  !', p)
    wps = [sum(len(l['t'].split()) for l in e['lines']) / e['meta']['dur_t'] for e in plan]
    print('语速 %.2f–%.2f 中位 %.2f' % (min(wps), max(wps), statistics.median(wps)))
    print('片段时长 %.1f–%.1f 秒' % (min(e['dur'] for e in plan), max(e['dur'] for e in plan)))
    print('含念题总长 %.1f 分钟' % (sum(e['dur'] for e in plan) / 60))
    cz = sum(1 for e in plan for l in e['lines'] if l.get('cloze'))
    ln = sum(len(e['lines']) for e in plan)
    print('挖空 %d / %d 行（%.0f%%）' % (cz, ln, cz / ln * 100))


if __name__ == '__main__':
    main()
