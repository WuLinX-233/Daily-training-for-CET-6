#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「真题高频」标记写进 words.json，并按「高频优先」重排整个词库。

数据源：
    wangjiuyi543-ui/cet6-vocabulary 的 cet6_high_frequency_words.csv
    （2020–2025 六级真题全文词频统计，MIT License）
    列：rank, word, lemma, raw_forms, part_of_speech, Chinese_meaning,
        total_frequency, document_count, exam_month_count, year_count,
        importance_score, tags, ...

判定：importance_score >= THRESHOLD（默认 10）算高频。
     score 是「频次 × 覆盖篇数 × 覆盖月份 × 覆盖年份」的综合分，
     比单纯看出现次数更能挑出「年年考、篇篇有」的词。

排序：高频词按 score 从高到低排在最前，非高频词保持原来的顺序跟在后面。
     app.js 是「按数组顺序 + cursor 往后取」抽新词的，所以排完序
     就天然做到「高频没学完，不会碰到非高频」。

用法：
    python tools/mark-high-freq.py <cet6_high_frequency_words.csv> [threshold]
"""
import csv
import json
import os
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDS = os.path.join(APP, 'words.json')
THRESHOLD = 10.0


def build_index(path):
    """word / lemma / 各种变形 -> 那一行。同一拼写取 rank 最靠前的。"""
    idx = {}
    with open(path, encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            keys = set()
            for k in ('word', 'lemma'):
                v = (row.get(k) or '').strip().lower()
                if v:
                    keys.add(v)
            for v in (row.get('raw_forms') or '').split(','):
                v = v.strip().lower()
                if v:
                    keys.add(v)
            try:
                rank = int(row.get('rank') or 0)
            except ValueError:
                rank = 0
            for k in keys:
                old = idx.get(k)
                if old is None or (rank and rank < old[0]):
                    idx[k] = (rank, row)
    return idx


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 else THRESHOLD
    idx = build_index(sys.argv[1])

    words = json.load(open(WORDS, encoding='utf-8'))
    hit = 0
    for w in words:
        rec = idx.get(w['en'].lower())
        if not rec:
            w.pop('hf', None)
            for k in ('fc', 'fd', 'fs'):
                w.pop(k, None)
            continue
        row = rec[1]
        score = float(row.get('importance_score') or 0)
        hit += 1
        w['fs'] = round(score, 1)                                   # 综合分
        w['fc'] = int(float(row.get('total_frequency') or 0))        # 真题出现次数
        w['fd'] = int(float(row.get('document_count') or 0))         # 覆盖篇数
        if score >= threshold:
            w['hf'] = 1
        else:
            w.pop('hf', None)

    # 高频在前（分数降序，同分按真题篇数、次数），非高频保持原顺序
    hf = [w for w in words if w.get('hf')]
    rest = [w for w in words if not w.get('hf')]
    hf.sort(key=lambda w: (-w['fs'], -w['fd'], -w['fc'], w['en']))
    out = hf + rest

    json.dump(out, open(WORDS, 'w', encoding='utf-8'), ensure_ascii=False, indent=None,
              separators=(',', ':'))
    print('词库 %d 词，命中词频表 %d 词（%.1f%%）' % (len(out), hit, hit * 100.0 / len(out)))
    print('高频（score>=%g）：%d 词；非高频：%d 词' % (threshold, len(hf), len(rest)))
    if hf:
        print('  最高：%s %.1f 分 / %d 篇 / %d 次' % (hf[0]['en'], hf[0]['fs'], hf[0]['fd'], hf[0]['fc']))
        print('  最低：%s %.1f 分 / %d 篇 / %d 次' % (hf[-1]['en'], hf[-1]['fs'], hf[-1]['fd'], hf[-1]['fc']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
