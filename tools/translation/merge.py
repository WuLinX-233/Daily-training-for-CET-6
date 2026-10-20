# 合并 3 批参考译文 → translation.json，并做结构自检
import os, re, json, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
items = json.load(open(os.path.join(HERE, 'items.json'), encoding='utf-8'))[:57]
ref = {}
for i in (1, 2, 3):
    ref.update(json.load(open(os.path.join(HERE, 'ref_%02d.json' % i), encoding='utf-8')))

print('原文 %d 篇，译文 %d 条' % (len(items), len(ref)))
CN = {'01': '1', '03': '3', '06': '6', '07': '7', '09': '9', '12': '12'}

out, bad = [], []
for i, x in enumerate(items, 1):
    k = '%02d' % i
    ym, st, topic = x['ym'], x['set'], x['topic']
    title = '%s年%s月 第%d套 · %s' % (ym[:4], CN.get(ym[4:], ym[4:]), st, topic)
    e = dict(
        date=(datetime.date(2026, 10, 19) + datetime.timedelta(days=i - 1)).isoformat(),
        title=title,
        zh=x['zh'],
        ref=ref.get(k, ''),
    )
    if not e['ref']:
        bad.append((k, '缺译文'))
    elif len(re.findall(r'[\u4e00-\u9fff]', e['zh'])) < 60:
        bad.append((k, '中文太短'))
    elif not re.match(r'^[A-Z"]', e['ref']):
        bad.append((k, '译文开头异常'))
    elif '\ufffd' in e['zh'] + e['ref']:
        bad.append((k, '残留杂符'))
    # 中文段数与英文段数应当一致
    elif len([p for p in e['zh'].split('\n') if p.strip()]) != len(
            [p for p in e['ref'].split('\n\n') if p.strip()]):
        bad.append((k, '段落数不一致 %d vs %d' % (
            len([p for p in e['zh'].split('\n') if p.strip()]),
            len([p for p in e['ref'].split('\n\n') if p.strip()]))))
    out.append(e)

print('问题 %d' % len(bad))
for b in bad:
    print('   ', b)

dst = os.path.join(ROOT, 'translation.json')
json.dump(out, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
wz = [len(x['zh']) for x in out]
wr = [len(x['ref'].split()) for x in out]
print('写入 %s' % dst)
print('%d 条，中文 %d–%d 字，译文 %d–%d 词，%.0f KB' % (
    len(out), min(wz), max(wz), min(wr), max(wr), os.path.getsize(dst) / 1024))
print('首条 %s | %s' % (out[0]['date'], out[0]['title']))
print('末条 %s | %s' % (out[-1]['date'], out[-1]['title']))
