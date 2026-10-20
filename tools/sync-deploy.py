# -*- coding: utf-8 -*-
"""把 cet6-app 同步到部署目录（只同步运行需要的文件，README 加「部署版」抬头）。

用法：python tools/sync-deploy.py     # 目标目录写在下面的 DST
"""
import filecmp, os, shutil, sys

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # cet6-app/
DST = 'D:/cet6'

# 开发目录里独有、线上用不到
SKIP = {'server.py', 'start-server.bat', 'tools', 'README.md', '.nojekyll',
        '_probe', '_build', '.git'}

HEADER = '''# CET-6 每日训练

> **这份是「部署版」**：只有网站运行需要的文件，直接整目录推到 GitHub 仓库根目录即可。
> 开发目录里额外有的 `server.py`、`start-server.bat`、`tools/`（数据生成脚本）**不在**这里 —— 那些是本地维护用的，线上用不到。
> 另外多了一个空文件 `.nojekyll`，作用是让 GitHub Pages 跳过 Jekyll 处理，别删。

'''


def walk(root):
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            if f in SKIP:
                continue
            p = os.path.join(base, f)
            yield os.path.relpath(p, root).replace('\\', '/'), p


def main():
    os.makedirs(DST, exist_ok=True)
    copied = same = removed = 0
    total = 0
    want = set()
    for rel, p in walk(SRC):
        want.add(rel)
        dst = os.path.join(DST, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst) and filecmp.cmp(p, dst, shallow=False):
            same += 1
        else:
            shutil.copy2(p, dst)
            copied += 1
        total += os.path.getsize(dst)

    # 删掉部署目录里多余的（旧的 12 段切片等）
    for rel, p in list(walk(DST)):
        if rel not in want:
            os.remove(p)
            removed += 1

    # README：开发版正文 + 部署版抬头
    body = open(os.path.join(SRC, 'README.md'), encoding='utf-8').read()
    # 去掉开发版可能已有的旧抬头
    if body.startswith('# CET-6 每日训练'):
        body = body.split('\n', 1)[1].lstrip('\n')
    open(os.path.join(DST, 'README.md'), 'w', encoding='utf-8').write(HEADER + body)

    open(os.path.join(DST, '.nojekyll'), 'w').close()

    print('同步完成：新增/更新 %d，未变 %d，删除多余 %d' % (copied, same, removed))
    print('部署目录 %.1f MB' % (total / 1048576))


if __name__ == '__main__':
    main()
