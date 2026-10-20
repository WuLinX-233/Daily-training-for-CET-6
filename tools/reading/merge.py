# 合并 4 批解析 → reading.json，并做结构自检
import os, re, json

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
entries = json.load(open(os.path.join(HERE, 'entries.json'), encoding='utf-8'))
ana = {}
for i in (1, 2, 3, 4):
    ana.update(json.load(open(os.path.join(HERE, 'ana_%02d.json' % i), encoding='utf-8')))

print('解析条数', len(ana))
bad = []
for i, e in enumerate(entries, 1):
    k = '%02d' % i
    if k not in ana:
        bad.append((k, '缺解析'))
        continue
    e['analysis'] = ana[k]

for i, e in enumerate(entries, 1):
    k = '%02d' % i
    p, s, a = e['passage'], e['sentence'], e['analysis']
    if s not in p:
        bad.append((k, 'sentence 不是 passage 子串'))
    if len(a) < 150:
        bad.append((k, 'analysis 太短 %d' % len(a)))
    if '\ufffd' in p + s + a or '  ' in p:
        bad.append((k, '残留杂符'))
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', e['date']):
        bad.append((k, 'date 格式'))
    for f in ('title', 'passage', 'sentence', 'analysis'):
        if not e.get(f):
            bad.append((k, '空字段 ' + f))

ds = [e['date'] for e in entries]
if len(set(ds)) != len(ds):
    bad.append(('-', '日期重复'))
if ds != sorted(ds):
    bad.append(('-', '日期非升序'))

print('问题 %d' % len(bad))
for b in bad:
    print('   ', b)
if bad:
    raise SystemExit(1)

# 只保留 app 需要的字段
out = [dict(date=e['date'], title=e['title'], passage=e['passage'],
            sentence=e['sentence'], analysis=e['analysis']) for e in entries]
dst = os.path.join(ROOT, 'reading.json')
json.dump(out, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

wa = [len(e['analysis']) for e in out]
wp = [len(e['passage'].split()) for e in out]
print('写入 %s' % dst)
print('条数 %d，段落 %d–%d 词，解析 %d–%d 字' % (
    len(out), min(wp), max(wp), min(wa), max(wa)))
print('文件大小 %.0f KB' % (os.path.getsize(dst) / 1024))
