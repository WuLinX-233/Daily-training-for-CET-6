# 解析 73 篇翻译真题 markdown：按 `### <a id="202512-第1套"></a>第 1 套 — 尊老` 切块
import os, re, json

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'source.md'), encoding='utf-8').read().replace('\r\n', '\n')

HEAD = re.compile(r'^###\s*<a id="(\d{6})-第(\d)套"></a>\s*第\s*\d\s*套\s*—\s*(.+)$', re.M)
# 目录区（`- [2025 年 12 月](#...)`）要排除：正文标题带 <a id=...>
marks = list(HEAD.finditer(src))
items = []
for i, m in enumerate(marks):
    ym, st, topic = m.group(1), m.group(2), m.group(3).strip()
    body = src[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(src)]
    # 去掉分隔线与"目录"尾巴
    body = body.split('\n---')[0]
    paras = [ln.strip() for ln in body.split('\n') if ln.strip()]
    zh = '\n'.join(paras)
    zh = re.sub(r'^[-*]\s*', '', zh).strip()
    if not zh or len(re.findall(r'[\u4e00-\u9fff]', zh)) < 60:
        continue
    items.append(dict(ym=ym, set=int(st), topic=topic, zh=zh))

print('解析出 %d 篇' % len(items))
print('年份覆盖 %s – %s' % (items[0]['ym'], items[-1]['ym']))
bad = [x for x in items if len(x['zh']) > 600 or len(x['zh']) < 80]
print('长度异常 %d' % len(bad))
for b in bad[:5]:
    print('   ', b['ym'], b['set'], b['topic'], len(b['zh']))
json.dump(items, open(os.path.join(HERE, 'items.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('→ items.json')
