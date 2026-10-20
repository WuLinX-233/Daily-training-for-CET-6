# -*- coding: utf-8 -*-
"""把 plan.json 落成 app 用的 listening.json（去掉内部调试字段）。"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))   # cet6-app/

plan = json.load(open(os.path.join(HERE, 'plan.json'), encoding='utf-8'))
out = []
for e in plan:
    out.append({
        'date': e['date'],
        'title': e['title'],
        'setId': e['setId'],
        'audio': e['audio'],
        'dur': e['dur'],
        'qAt': e['qAt'],
        'lines': e['lines'],
        'questions': e['questions'],
    })

dst = os.path.join(APP, 'listening.json')
json.dump(out, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

# 自检
n_line = sum(len(e['lines']) for e in out)
n_q = sum(len(e['questions']) for e in out)
n_zh = sum(1 for e in out for l in e['lines'] if l.get('zh'))
n_cz = sum(1 for e in out for l in e['lines'] if l.get('cloze'))
bad = []
for e in out:
    if not (0 < e['qAt'] < e['dur']):
        bad.append((e['setId'], 'qAt 越界'))
    for l in e['lines']:
        if not (0 <= l['a'] < l['b'] <= e['dur'] + 0.01):
            bad.append((e['setId'], '句时间越界', l['a'], l['b'], e['dur']))
    for q in e['questions']:
        if len(q['options']) != 4:
            bad.append((e['setId'], '选项数', len(q['options'])))
        if q['answer'] not in 'ABCD':
            bad.append((e['setId'], '答案', q['answer']))
        if not (0 <= q['at'] < len(e['lines'])):
            bad.append((e['setId'], 'at 越界', q['at']))

print('写入 %s' % dst)
print('  条目 %d  句 %d  题 %d  中文 %d  挖空 %d' % (len(out), n_line, n_q, n_zh, n_cz))
print('  文件 %.0f KB' % (os.path.getsize(dst) / 1024))
print('  自检问题 %d 项' % len(bad))
for b in bad[:15]:
    print('   !', b)
