# -*- coding: utf-8 -*-
"""离线补词典：把正文里出现、但 words.json / dict.json 没收录的词，从有道补一份
{en, pos, us, zh} 写进 dict_extra.json。

为什么要有这个文件
------------------
words.json（2487）+ dict.json（226）只覆盖阅读正文词次的 59%。剩下的词取词时会落到
在线接口，而在线接口（dictionaryapi.dev）很不稳定，拿不到音标和词性 —— 卡片上就只剩
一行机翻的中文。这个文件是一次性构建的，运行时零网络请求，也不占用户流量。

怎么用
------
    python tools/build_dict_extra.py             # 增量：已经有的词跳过
    python tools/build_dict_extra.py --rebuild   # 全量重抓

数据来源是有道词典的公开 jsonapi（和发音接口 dictvoice 同一个站）。只取
ec.word[0] 里的 usphone / trs，其余几十 KB 的例句、词源一律丢掉。

条目格式和 dict.json 的 words 完全一致，所以 app.js 里直接并进 DICT_MAP 就行。
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'dict_extra.json')
API = 'https://dict.youdao.com/jsonapi?q='
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) cet6-dict-builder'

WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")
POS_RE = re.compile(r'^\s*((?:[a-z]{1,5}\.\s*)+)')
MAX_ZH = 150


def collect_words():
    """正文（阅读 + 听力 + 翻译）里出现过的所有英文词，小写去重。"""
    words = set()

    def feed(text):
        for m in WORD_RE.findall(text or ''):
            words.add(m.lower())

    with open(os.path.join(ROOT, 'reading.json'), encoding='utf-8') as f:
        for it in json.load(f):
            feed(it.get('passage'))
            feed(it.get('sentence'))

    with open(os.path.join(ROOT, 'listening.json'), encoding='utf-8') as f:
        for it in json.load(f):
            for ln in it.get('lines') or []:
                feed(ln.get('t'))

    with open(os.path.join(ROOT, 'translation.json'), encoding='utf-8') as f:
        for it in json.load(f):
            feed(it.get('ref'))

    return words


def known_words():
    """words.json + dict.json 已经能查到的词（含词形还原能查到的）。"""
    with open(os.path.join(ROOT, 'words.json'), encoding='utf-8') as f:
        w = json.load(f)
    with open(os.path.join(ROOT, 'dict.json'), encoding='utf-8') as f:
        d = json.load(f)
    return set(x['en'].lower() for x in w) | set(x['en'].lower() for x in (d.get('words') or []))


def fetch(word):
    url = API + urllib.parse.quote(word)
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


def parse(word, data):
    """从有道 jsonapi 里抠出 {en, pos, us, zh}；抠不出来返回 None。"""
    ec = data.get('ec') or {}
    arr = ec.get('word') or []
    if not arr:
        return None
    w0 = arr[0]

    lines = []
    for tr in (w0.get('trs') or []):
        for one in (tr.get('tr') or []):
            for s in ((one.get('l') or {}).get('i') or []):
                if isinstance(s, str) and s.strip():
                    lines.append(s.strip())
    if not lines:
        return None

    pos_list, zh_parts = [], []
    for s in lines[:3]:
        m = POS_RE.match(s)
        if m:
            for p in m.group(1).split():
                if p not in pos_list:
                    pos_list.append(p)
            s = s[m.end():].strip()
        if s:
            zh_parts.append(s)

    zh = '；'.join(zh_parts)
    if len(zh) > MAX_ZH:
        zh = zh[:MAX_ZH].rstrip('；，、') + '…'
    if not zh:
        return None

    us = (w0.get('usphone') or '').strip()
    proto = (w0.get('prototype') or '').strip()

    return {
        'en': word,
        'pos': ' / '.join(pos_list),
        'us': us,
        'zh': zh,
        '_proto': proto,          # 变形词的还原形，用来补音标，最后不写进文件
    }


def main():
    rebuild = '--rebuild' in sys.argv

    old = {}
    if os.path.exists(OUT) and not rebuild:
        with open(OUT, encoding='utf-8') as f:
            for e in json.load(f).get('words') or []:
                old[e['en']] = e
        print('已有 %d 条，增量补' % len(old))

    have = known_words()
    todo = sorted(w for w in collect_words() if w not in have and w not in old)
    print('正文共 %d 个不同词，需要新抓 %d 个' % (len(collect_words()), len(todo)))
    if not todo:
        print('没有要补的')
        return

    got, miss = {}, []
    t0 = time.time()
    done = [0]

    def work(word):
        for attempt in range(3):
            try:
                e = parse(word, fetch(word))
                return word, e
            except Exception:
                time.sleep(0.4 * (attempt + 1))
        return word, None

    with ThreadPoolExecutor(max_workers=4) as pool:
        for word, e in pool.map(work, todo):
            done[0] += 1
            if e:
                got[word] = e
            else:
                miss.append(word)
            if done[0] % 200 == 0:
                print('  %d/%d  已补 %d  用时 %.0fs'
                      % (done[0], len(todo), len(got), time.time() - t0), flush=True)

    # 变形词（marketers）常常只有释义没有音标，用原型（marketer）补一次
    need = sorted({e['_proto'] for e in got.values() if not e['us'] and e.get('_proto')})
    need = [w for w in need if w not in got]
    print('还有 %d 个变形词要补音标' % len(need))
    if need:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for word, e in pool.map(work, need):
                if e and e['us']:
                    got[word] = e
        for e in got.values():
            if not e['us'] and e.get('_proto'):
                p = got.get(e['_proto'])
                if p:
                    e['us'] = p['us']

    for e in got.values():
        e.pop('_proto', None)
        if not e['us']:
            e.pop('us', None)

    merged = dict(old)
    merged.update(got)
    rows = sorted(merged.values(), key=lambda x: x['en'])

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({
            '_src': '有道词典 jsonapi（tools/build_dict_extra.py 生成，勿手改）',
            '_built': time.strftime('%Y-%m-%d'),
            'words': rows,
        }, f, ensure_ascii=False, separators=(',', ':'))

    print('写入 %s：%d 条（本轮新增 %d，查不到 %d）'
          % (os.path.basename(OUT), len(rows), len(got), len(miss)))
    if miss:
        print('查不到的前 20 个：', ' '.join(miss[:20]))


if __name__ == '__main__':
    main()
