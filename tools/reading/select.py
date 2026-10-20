# 严格选句：必须单句、无 OCR 残迹、是原文连续子串。
# 输出每篇前 3 个候选，供人工在残句较多时改选。
import os, re, json, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(os.path.join(HERE, 'passages.json'), encoding='utf-8'))

ABBR = re.compile(r'\b(Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|Inc|Ltd|No|Fig|e\.g|i\.e|U\.S|U\.K)\.')
MARK = re.compile(
    r'\b(which|that|who|whom|whose|where|when|while|although|though|because|since|'
    r'unless|whether|if|as|than|so that|even though|rather than|instead of|'
    r'not only|but also|what|how|why|forcing|making|allowing)\b', re.I)
# OCR 残迹
CORRUPT = [
    re.compile(r'\w_\w'),                       # relig_ion
    re.compile(r'\d+[A-Za-z]{2,}\b'),           # 1,023,330 krn 之类
    re.compile(r'\s{2,}'),
    re.compile(r'\(\s*[a-z;]{1,4}\s*\)'),       # (tf; )
]


def split_sentences(t):
    s = ABBR.sub(lambda m: m.group(0).replace('.', '<D>'), t)
    s = re.sub(r'(\d)\.(\d)', r'\1<D>\2', s)
    out, buf = [], ''
    for p in re.split(r'(?<=[.!?])\s+', s):
        buf = (buf + ' ' + p).strip() if buf else p
        if re.search(r'[.!?]["\']?$', p):
            out.append(buf)
            buf = ''
    if buf:
        out.append(buf)
    return [x.replace('<D>', '.').strip() for x in out if x.strip()]


def ok_sentence(s, passage):
    if not (22 <= len(s.split()) <= 70):
        return False
    if s not in passage:                       # 必须连续子串
        return False
    if not re.match(r'^["\'(]?[A-Z]', s):      # 不能从句中起
        return False
    if not re.search(r'[.!?"\']$', s):
        return False
    if re.search(r'[.!?]["\']?\s+[A-Z]', s):   # 内部还有句号 → 两句粘连
        return False
    for c in CORRUPT:
        if c.search(s):
            return False
    return True


def score(s):
    sc = len(s.split()) * 0.55
    sc += 3.0 * len(set(m.group(0).lower() for m in MARK.finditer(s)))
    sc += 1.6 * s.count(',') + 1.2 * s.count(';') + 2.5 * s.count(':')
    sc -= 1.0 * s.count('(')
    return round(sc, 1)


def key(setname):
    m = re.match(r'(\d{4})[-_](\d{2})[-_](\d{1,2})', setname)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else (0, 0, 0)


CN = {'01': '1', '03': '3', '06': '6', '07': '7', '09': '9', '12': '12'}
rows.sort(key=lambda r: key(r['set']), reverse=True)

picks, dropped = [], []
for r in rows:
    cands = [s for s in split_sentences(r['text']) if ok_sentence(s, r['text'])]
    if not cands:
        dropped.append((r['set'], r['q1']))
        continue
    cands.sort(key=score, reverse=True)
    m = re.match(r'(\d{4})[-_](\d{2})[-_](\d{1,2})', r['set'])
    yr, mo, st = int(m.group(1)), m.group(2), int(m.group(3))
    title = '%d年%s月 第%d套 · Passage %s' % (yr, CN.get(mo, mo), st,
                                             'One' if r['q1'] < 50 else 'Two')
    picks.append(dict(title=title, set=r['set'], q1=r['q1'], words=r['words'],
                      passage=r['text'],
                      cands=[dict(s=c, sc=score(c)) for c in cands[:3]]))

print('可用篇数 %d，丢弃 %d %s' % (len(picks), len(dropped), dropped))
picks = picks[:57]
for i, p in enumerate(picks):
    p['date'] = (datetime.date(2026, 10, 19) + datetime.timedelta(days=i)).isoformat()
    p['sentence'] = p['cands'][0]['s']
json.dump(picks, open(os.path.join(HERE, 'picks.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('采用 %d 篇，全部通过严格校验' % len(picks))
