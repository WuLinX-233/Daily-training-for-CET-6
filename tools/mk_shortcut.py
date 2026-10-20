# -*- coding: utf-8 -*-
"""用 IShellLinkW + IPersistFile COM 接口创建带图标的桌面快捷方式

路径全部从本文件位置推导，仓库搬到哪都能跑：
  图标   <仓库>/icons/icon.ico
  目标   <桌面>/CET6训练启动器.bat
  产物   <桌面>/CET6训练.lnk
"""
import ctypes
import os
from ctypes import byref, c_void_p, c_wchar_p, c_int, POINTER, WINFUNCTYPE, windll, WinError

HRESULT = ctypes.c_long
CLSCTX_INPROC_SERVER = 1

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP = os.path.join(os.path.expanduser('~'), 'Desktop')
ICON = os.path.join(ROOT, 'icons', 'icon.ico')
BAT = os.path.join(DESKTOP, 'CET6训练启动器.bat')
LNK = os.path.join(DESKTOP, 'CET6训练.lnk')

for _p in (ICON, BAT):
    if not os.path.exists(_p):
        raise SystemExit('找不到：%s' % _p)


class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong),
                ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort),
                ("Data4", ctypes.c_ubyte * 8)]


def guid(d1, d2, d3, d4):
    g = GUID()
    g.Data1 = d1
    g.Data2 = d2
    g.Data3 = d3
    for i, b in enumerate(d4):
        g.Data4[i] = b
    return g


CLSID_ShellLink = guid(0x00021401, 0, 0, (0xC0, 0, 0, 0, 0, 0, 0, 0x46))
IID_IShellLinkW = guid(0x000214F9, 0, 0, (0xC0, 0, 0, 0, 0, 0, 0, 0x46))
IID_IPersistFile = guid(0x0000010B, 0, 0, (0xC0, 0, 0, 0, 0, 0, 0, 0x46))

ole32 = windll.ole32
ole32.CoInitialize(None)

sl = c_void_p()
hr = ole32.CoCreateInstance(byref(CLSID_ShellLink), None, CLSCTX_INPROC_SERVER,
                            byref(IID_IShellLinkW), byref(sl))
if hr != 0:
    raise WinError(hr)

vtbl = ctypes.cast(ctypes.cast(sl, POINTER(c_void_p))[0], POINTER(c_void_p))


def call(idx, proto, *args):
    fn = proto(vtbl[idx])
    return fn(sl, *args)


def check(hr, what):
    if hr != 0:
        raise WinError(hr)


check(call(20, WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p), BAT), "SetPath")
check(call(17, WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p, c_int), ICON, 0), "SetIconLocation")
check(call(7, WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p),
           "CET-6 每日训练：单词闪卡 · 每日阅读 · 每日听力 · 每日翻译"), "SetDescription")
check(call(9, WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p), DESKTOP), "SetWorkingDirectory")

# QueryInterface -> IPersistFile
pf = c_void_p()
qi = WINFUNCTYPE(HRESULT, c_void_p, POINTER(GUID), POINTER(c_void_p))(vtbl[0])
check(qi(sl, byref(IID_IPersistFile), byref(pf)), "QueryInterface")

pvtbl = ctypes.cast(ctypes.cast(pf, POINTER(c_void_p))[0], POINTER(c_void_p))
save = WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p, c_int)(
    pvtbl[6])  # IPersistFile::Save = vtable index 6
check(save(pf, LNK, True), "Save")

print("shortcut created OK")
print("  target:", BAT)
print("  icon  :", ICON)
print("  lnk   :", LNK)
