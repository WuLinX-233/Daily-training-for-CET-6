# -*- coding: utf-8 -*-
"""用 IShellLinkW + IPersistFile COM 接口创建带图标的桌面快捷方式"""
import ctypes
from ctypes import byref, c_void_p, c_wchar_p, c_int, POINTER, WINFUNCTYPE, windll, WinError

HRESULT = ctypes.c_long
CLSCTX_INPROC_SERVER = 1


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


check(call(20, WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p),
           r"C:\Users\WuLinX\Desktop\CET6训练启动器.bat"), "SetPath")
check(call(17, WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p, c_int),
           r"C:\Users\WuLinX\WorkBuddy AI\2026-10-18-16-15-19\cet6-app\icons\icon.ico", 0), "SetIconLocation")
check(call(7, WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p),
           "CET-6 每日训练：单词闪卡 · 每日阅读 · 每日听力 · 每日翻译"), "SetDescription")
check(call(9, WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p),
           r"C:\Users\WuLinX\Desktop"), "SetWorkingDirectory")

# QueryInterface -> IPersistFile
pf = c_void_p()
qi = WINFUNCTYPE(HRESULT, c_void_p, POINTER(GUID), POINTER(c_void_p))(vtbl[0])
check(qi(sl, byref(IID_IPersistFile), byref(pf)), "QueryInterface")

pvtbl = ctypes.cast(ctypes.cast(pf, POINTER(c_void_p))[0], POINTER(c_void_p))
save = WINFUNCTYPE(HRESULT, c_void_p, c_wchar_p, c_int)(
    pvtbl[6])  # IPersistFile::Save = vtable index 6
check(save(pf, r"C:\Users\WuLinX\Desktop\CET6训练.lnk", True), "Save")

print("shortcut created OK")
