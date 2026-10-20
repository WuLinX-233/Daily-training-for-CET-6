# 从 api.github.com 逐份取回 62 套真题 TXT（raw 域名在本机不稳，走 contents API + base64）
import json, base64, urllib.request, os

API = 'https://api.github.com/repos/AndrewYuZhenYu/cet6_exam_questions_txt_collection/contents/cet6_zhenti_cleaned'
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
lst = json.load(op.open(API, timeout=30))
os.makedirs('data', exist_ok=True)

for x in lst:
    p = os.path.join('data', x['name'])
    if os.path.exists(p) and os.path.getsize(p) > 5000:
        continue
    for attempt in range(3):
        try:
            d = json.load(op.open(API + '/' + x['name'], timeout=30))
            open(p, 'wb').write(base64.b64decode(d['content']))
            break
        except Exception as e:
            if attempt == 2:
                print('ERR', x['name'], e)

print('ok', len(os.listdir('data')))
