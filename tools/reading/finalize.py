# 定稿：应用人工改选（OCR 残句太多时换候选），并为每篇分配日期。
# 索引从 1 开始，与审阅时打印的编号一致。
import os, re, json, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
picks = json.load(open(os.path.join(HERE, 'picks.json'), encoding='utf-8'))
allp = json.load(open(os.path.join(HERE, 'passages.json'), encoding='utf-8'))

# 1-based 序号 → 候选下标
OVERRIDE = {9: 2, 20: 2, 27: 1, 28: 2, 32: 1, 34: 2, 42: 2,
            45: 1, 46: 2, 54: 1, 55: 1}
# 这一篇的候选全是 OCR 残句，整篇换成第 58 篇
SWAP = {52: 58}

for i, p in enumerate(picks, 1):
    if i in OVERRIDE:
        p['sentence'] = p['cands'][OVERRIDE[i]]['s']
        print('改选 %02d → 候选#%d' % (i, OVERRIDE[i]))

# 备用篇：allp 里没被 picks 用到的
used = {(p['set'], p['q1']) for p in picks}
spare = [r for r in allp if (r['set'], r['q1']) not in used]
print('备用篇 %d' % len(spare))

for pos, src in SWAP.items():
    r = spare.pop(0)
    m = re.match(r'(\d{4})[-_](\d{2})[-_](\d{1,2})', r['set'])
    CN = {'01': '1', '03': '3', '06': '6', '07': '7', '09': '9', '12': '12'}
    title = '%d年%s月 第%d套 · Passage %s' % (int(m.group(1)), CN.get(m.group(2), m.group(2)),
                                             int(m.group(3)), 'One' if r['q1'] < 50 else 'Two')
    picks[pos - 1].update(title=title, set=r['set'], q1=r['q1'], words=r['words'],
                          passage=r['text'], sentence='', cands=[])
    print('换篇 %02d ← %s' % (pos, title))

# 换篇后缺句子的，重新从该篇里选
MARK = re.compile(r'\b(which|that|who|whom|whose|where|when|while|although|though|'
                  r'because|since|unless|whether|if|as|than|rather than|instead of|'
                  r'not only|but also|what|how|why)\b', re.I)


def split_sentences(t):
    t = re.sub(r'\b(Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|Inc|Ltd|U\.S|U\.K)\.', r'\1<D>', t)
    t = re.sub(r'(\d)\.(\d)', r'\1<D>\2', t)
    out, buf = [], ''
    for p in re.split(r'(?<=[.!?])\s+', t):
        buf = (buf + ' ' + p).strip() if buf else p
        if re.search(r'[.!?]["\']?$', p):
            out.append(buf)
            buf = ''
    return [x.replace('<D>', '.').strip() for x in out if x.strip()]


def sc(s):
    return (len(s.split()) * 0.55 + 3.0 * len(set(m.group(0).lower() for m in MARK.finditer(s)))
            + 1.6 * s.count(',') + 1.2 * s.count(';') + 2.5 * s.count(':') - s.count('('))


for p in picks:
    if p['sentence']:
        continue
    cands = [s for s in split_sentences(p['passage'])
             if 22 <= len(s.split()) <= 70 and s in p['passage']
             and re.match(r'^["\'(]?[A-Z]', s) and not re.search(r'[.!?]["\']?\s+[A-Z]', s)
             and '_' not in s and '  ' not in s]
    cands.sort(key=sc, reverse=True)
    p['sentence'] = cands[0]
    print('补选 %02d: %s' % (picks.index(p) + 1, p['sentence'][:70]))

# 分配日期、清掉多余字段
for i, p in enumerate(picks):
    p['date'] = (datetime.date(2026, 10, 19) + datetime.timedelta(days=i)).isoformat()
    p.pop('cands', None)
    p.pop('score', None)
    p.pop('q1', None)
    p.pop('set', None)
    p.pop('words', None)
    p['analysis'] = ''

json.dump(picks, open(os.path.join(HERE, 'entries.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('\n定稿 %d 篇 → entries.json' % len(picks))
for p in picks[:3] + picks[-2:]:
    print(' ', p['date'], p['title'])
