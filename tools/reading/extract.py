# 抽 Section C 仔细阅读原文。
# 锚点用「Questions N to M are based on the (following) passage」而不是 Part III / Passage One
# —— 62 套里标题残缺很普遍，但这句引导语几乎都在。
# 结束条件：遇到题号行（46.）或选项行（A.）即止。
import os, re, json

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'data')

ANCHOR = re.compile(
    r'Questions?\s+(\d{1,2})\s+to\s+(\d{1,2})\s+are\s+based\s+on\s+the\s+(?:following\s+)?passage[^\n]*\n',
    re.I)
STOP = re.compile(r'^\s*(?:\d{1,2}\s*[\.\)]|[A-D]\s*[\.\)])\s')
JUNK = ('听力原文听力原文', '听力原文', '我的作文', '我的翻译', '翻译范文', '播放听力')
# hyphen 右侧是这些词尾时，说明是断行断词，不是复合词
SUFFIX = re.compile(
    r'\b([a-z]{2,})-(ing|ed|er|est|ly|tion|sion|ment|ness|able|ible|ance|ence|'
    r'ous|ive|al|ic|ity|ies|es|s|ful|less|ally)\b')


def clean(text):
    t = text.replace('\r\n', '\n').replace('\u3000', ' ')
    t = t.replace('\u2019', "'").replace('\u2018', "'")
    t = t.replace('\u201c', '"').replace('\u201d', '"')
    for j in JUNK:
        t = t.replace(j, ' ')
    for ch in ('\ufffd', '\u00b7', '\u200b', '\u25a0', '\u25a1', '\u2022'):
        t = t.replace(ch, ' ')
    keep = []
    for ln in t.split('\n'):
        ln = ln.strip()
        if not ln:
            continue
        if re.fullmatch(r'[-–—\s]*\d{1,3}[-–—\s]*', ln) or re.fullmatch(r'\d+\s*/\s*\d+', ln):
            continue
        if re.match(r'^(Part\s+[IVX]+|Section\s+[A-C]|Passage\s+(One|Two|Three))$', ln, re.I):
            continue
        if re.match(r'^Directions?[:\s]', ln, re.I):
            continue
        keep.append(ln)
    s = ' '.join(keep)
    # 断行处先保留连字符（text- / to-image 才不会被粘成 texttoimage），
    # 再把「词干-常见词尾」的断词还原掉
    s = re.sub(r'(\w)-\s+(\w)', r'\1-\2', s)
    s = SUFFIX.sub(r'\1\2', s)
    return re.sub(r'\s+', ' ', s).strip()


rows, skipped = [], []
for f in sorted(os.listdir(D)):
    if not f.endswith('.txt'):
        continue
    t = open(os.path.join(D, f), encoding='utf-8', errors='replace').read().replace('\r\n', '\n')
    for m in ANCHOR.finditer(t):
        q1, q2 = int(m.group(1)), int(m.group(2))
        if q1 < 40:                       # 听力/选词填空的引导语，跳过
            continue
        rest = t[m.end():]
        off = 0
        for ln in rest.split('\n'):
            if STOP.match(ln):
                break
            off += len(ln) + 1
        s = clean(rest[:off])
        # 段首残句：OCR 常从行中间起，丢掉到第一个句末标点为止的碎片
        if s and s[0].islower():
            m2 = re.search(r'[.!?]\s', s)
            if m2:
                s = s[m2.end():]
        w = len(s.split())
        why = ''
        if not (250 <= w <= 750):
            why = '词数 %d' % w
        elif not re.search(r'[.!?"\']$', s):
            why = '结尾异常: …' + s[-40:]
        elif re.search(r'\bWhat does the (author|speaker)\b', s):
            why = '混入题干'
        if why:
            skipped.append((f, q1, why))
        else:
            rows.append(dict(set=f, q1=q1, q2=q2, words=w, text=s))

print('合格段落 %d' % len(rows))
print('丢弃 %d' % len(skipped))
for x in skipped:
    print('   ', x[0], 'Q%d' % x[1], x[2][:60])
ws = sorted(r['words'] for r in rows)
print('词数 min/中位/max = %d / %d / %d' % (ws[0], ws[len(ws) // 2], ws[-1]))
json.dump(rows, open(os.path.join(HERE, 'passages.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('→ passages.json')
