#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建「历年听力精听」的句级数据。

输入：
    <真题仓库>/CET6_YYYY.MM/*_transcript.md     听力原文（含 [N] 题号定位）
    <真题仓库>/CET6_YYYY.MM/*_q_stem.txt        选项
    <真题仓库>/CET6_YYYY.MM/*_q_answer.txt      答案
    <精听仓库>/translations.json                逐句中文翻译（机器翻译，CC BY 4.0）
    timings.json                                句级时间轴（getfine 仓库的 web/data/timestamps.json）

输出：
    listen/index.json          套卷清单（供下拉框用）
    listen/<id>.json           每套的逐句数据：原文 + 翻译 + 说话人 + 章节 + 起止时间
    （不生成 listening.json）

注意：listening.json 里「每日听力」的片段是手工维护的 —— 它的 dur / qAt / lines[].a·b
是按 audio/seg/ 里切好的小片段标的，不是按整段音频。重切音频后必须重新标，
规则见 README「八、数据维护 → 3. 每日听力」。

用法：
    python tools/build-listen-data.py <真题仓库> <精听仓库数据目录> [timings.json]
"""
import json
import os
import re
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LISTEN_DIR = os.path.join(APP, 'listen')

# 句末缩写，不能在这些词后面断句（与 getfine 的 lib-sentences.mjs 保持一致，
# 这样 normalizeKey 才能命中他们的翻译表）
ABBR = set("""mr mrs ms dr prof st vs etc inc ltd jr sr co corp u.s u.n d.c a.m p.m
no nos fig vol jan feb mar apr jun jul aug sep sept oct nov dec approx e.g i.e""".split())
BLOCK = re.compile(r'^\s*(conversation|passage|recording|lecture|talk|report|mini-lecture)\b', re.I)


def norm_key(text):
    return re.sub(r'\s+', ' ', text.lower()).strip()


def split_sentences(text, markers):
    """切句，同时把 [N] 题号标记分配给落在里面的句子。"""
    # 先把 [N] 抽出来换成占位符，切完再放回对应句子
    holes = []

    def stash(m):
        holes.append(int(m.group(1)))
        return ' \x00%d\x00 ' % (len(holes) - 1)

    text = re.sub(r'\[(\d+)\]', stash, text)
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return []
    words = text.split(' ')
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        stripped = re.sub(r'[)"\'\]]+$', '', w)
        if not re.search(r'[.!?]$', stripped):
            continue
        core = re.sub(r'\.$', '', stripped).lower()
        if core in ABBR or len(core) <= 1:
            continue
        nxt = words[i + 1] if i + 1 < len(words) else None
        if nxt and not re.match(r'^["\'\(\[]?[A-Z0-9“‘\x00]', nxt):
            continue
        out.append(' '.join(cur))
        cur = []
    if cur:
        out.append(' '.join(cur))

    result = []
    for sent in out:
        nums = [holes[int(x)] for x in re.findall(r'\x00(\d+)\x00', sent)]
        clean = re.sub(r'\x00\d+\x00', ' ', sent)
        clean = re.sub(r'\s+', ' ', clean).strip()
        clean = re.sub(r'\s+([,.;:!?])', r'\1', clean)
        if re.search(r'[a-zA-Z]{2}', clean):
            result.append((clean, nums))
    return result


def parse_transcript(text):
    """原文 → [{speaker, section, text, marks}]"""
    blocks, section = [], ''
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('<!--'):
            continue
        if line.startswith('#'):
            h = re.sub(r'^#+\s*', '', line).strip()
            if BLOCK.match(h):
                section = h
            continue
        m = re.match(r'^([MW]):\s*(.*)$', line)
        if m:
            if m.group(2).strip():
                blocks.append({'speaker': m.group(1), 'section': section, 'text': m.group(2).strip()})
        elif blocks and blocks[-1]['section'] == section:
            blocks[-1]['text'] += ' ' + line
        else:
            blocks.append({'speaker': '', 'section': section, 'text': line})

    out = []
    for b in blocks:
        for sent, marks in split_sentences(b['text'], None):
            out.append({'speaker': b['speaker'], 'section': b['section'], 'text': sent, 'marks': marks})
    return out


def parse_stem(path):
    qs, cur = {}, None
    for line in open(path, encoding='utf-8-sig').read().splitlines():
        m = re.match(r'\s*(\d+)\.\s*([A-D])\)\s*(.+)$', line)
        if m:
            cur = int(m.group(1))
            qs.setdefault(cur, {})[m.group(2)] = m.group(3).strip()
            continue
        m = re.match(r'\s*([A-D])\)\s*(.+)$', line)
        if m and cur:
            qs[cur][m.group(1)] = m.group(2).strip()
            continue
        m = re.match(r'\s*(\d+)\.', line)
        if m:
            cur = int(m.group(1))
    return {k: v for k, v in qs.items() if len(v) == 4}


def parse_answers(path):
    txt = open(path, encoding='utf-8-sig').read()
    return {int(n): a for n, a in re.findall(r'^\s*(\d+)\.\s*([A-D])\s*$', txt, re.M)}


def collect_sets(repo):
    sets = []
    for folder in sorted(os.listdir(repo)):
        if not re.match(r'^CET6_\d{4}\.\d{2}$', folder):
            continue
        base = os.path.join(repo, folder)
        for name in sorted(os.listdir(base)):
            m = re.match(r'^(cet6|CET6)_(\d{4})\.(\d{2})_set(\d)_transcript\.md$', name)
            if not m:
                continue
            y, mo, st = m.group(2), m.group(3), m.group(4)
            prefix = os.path.join(base, 'cet6_%s.%s_set%s' % (y, mo, st))
            if not os.path.exists(prefix + '_q_stem.txt'):
                continue
            sets.append({
                'id': '%s-%s-%s' % (y, mo, st),
                'year': int(y), 'month': int(mo), 'set': int(st),
                'label': '%s年%s月 第%s套' % (y, int(mo), '一二三四'[int(st) - 1]),
                'transcript': os.path.join(base, name),
                'stem': prefix + '_q_stem.txt',
                'answer': prefix + '_q_answer.txt',
            })
    return sets


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    repo, data_dir = sys.argv[1], sys.argv[2]
    timings_path = sys.argv[3] if len(sys.argv) > 3 else None

    translations = json.load(open(os.path.join(data_dir, 'translations.json'), encoding='utf-8'))
    timings = json.load(open(timings_path, encoding='utf-8')) if timings_path and os.path.exists(timings_path) else {}

    os.makedirs(LISTEN_DIR, exist_ok=True)
    sets = collect_sets(repo)
    index = []

    for s in sets:
        lines = parse_transcript(open(s['transcript'], encoding='utf-8-sig').read())
        ts = timings.get(s['id']) or []
        for i, ln in enumerate(lines):
            ln['zh'] = translations.get(norm_key(ln['text']), '')
            if i < len(ts):
                ln['a'], ln['b'] = ts[i][0], ts[i][1]
        payload = {
            'id': s['id'], 'label': s['label'],
            'lines': lines,
        }
        json.dump(payload, open(os.path.join(LISTEN_DIR, s['id'] + '.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, separators=(',', ':'))
        sections = []
        for ln in lines:
            if ln['section'] and (not sections or sections[-1]['name'] != ln['section']):
                sections.append({'name': ln['section'], 'n': 0})
            if sections:
                sections[-1]['n'] += 1
        index.append({
            'id': s['id'], 'label': s['label'], 'year': s['year'], 'month': s['month'],
            'set': s['set'], 'count': len(lines),
            'sections': sections,
            'zhCount': sum(1 for ln in lines if ln['zh']),
            'timed': bool(ts),
        })
        print('%-18s %3d 句  翻译 %3d  时间轴 %s  章节 %s'
              % (s['label'], len(lines), sum(1 for ln in lines if ln['zh']),
                 '有' if ts else '无', ' / '.join('%s(%d)' % (x['name'], x['n']) for x in sections)))

    json.dump(index, open(os.path.join(LISTEN_DIR, 'index.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('已写入 listen/index.json，共 %d 套' % len(index))
    return 0


if __name__ == '__main__':
    sys.exit(main())
