# -*- coding: utf-8 -*-
"""把 app 的 PNG 图标包装成 Windows .ico（单条目 256x256，内嵌 PNG，Win10/11 原生支持）"""
import struct
import sys

png_path = sys.argv[1]
ico_path = sys.argv[2]

with open(png_path, "rb") as f:
    png = f.read()

# ICONDIR: reserved=0, type=1(icon), count=1
header = struct.pack("<HHH", 0, 1, 1)
# ICONDIRENTRY: w=0(256), h=0(256), colors=0, reserved=0, planes=1, bpp=32, size, offset=22
entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)

with open(ico_path, "wb") as f:
    f.write(header + entry + png)

print("OK ->", ico_path, len(png), "bytes PNG wrapped")
