#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""dsh-harness-pilot 窗口助手 —— 常驻子进程，NDJSON over stdin/stdout。

目标：让 DSH 能「像人一样」操控另一个 harness 的窗口，但**不依赖截图 OCR**：
  * 找窗口 / 聚焦       —— user32 + uiautomation
  * 读窗口文本          —— UI Automation 无障碍树（首选）/ 控制台屏幕缓冲区（终端）
  * 敲键盘 / 点鼠标     —— pyautogui（SendInput）
  * 截图                —— 仅作兜底（PrintWindow 优先，被遮挡也能拍）

请求：{"id":1,"cmd":"find","title":"opencode"}
响应：{"id":1,"ok":true,...}

设计要点：
* 启动即置 per-monitor-v2 DPI 感知（截图像素 = 物理坐标）。
* 常驻进程避免每次动作重付 python + pyautogui + uiautomation 的导入成本。
* 读文本走「无障碍树」而不是 OCR：Windows Terminal / conhost / Electron 应用都把
  可见文本暴露在 UIA 树上；读不到时显式返回空 + 提示，而不是编造。
"""

import ctypes
import ctypes.wintypes as wt
import json
import re
import subprocess
import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stdin.reconfigure(encoding="utf-8")

_u32 = ctypes.windll.user32
_k32 = ctypes.windll.kernel32

# 64 位句柄必须声明 restype，否则 HGLOBAL 被截断（py3.12 实测 GlobalLock 返回 0 + 访问冲突）
_k32.GlobalAlloc.restype = ctypes.c_void_p
_k32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
_k32.GlobalLock.restype = ctypes.c_void_p
_k32.GlobalLock.argtypes = [ctypes.c_void_p]
_k32.GlobalUnlock.argtypes = [ctypes.c_void_p]
# SetClipboardData / GetClipboardData 在 user32；GlobalAlloc/Lock/Unlock 在 kernel32
_u32.SetClipboardData.restype = ctypes.c_void_p
_u32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
_u32.GetClipboardData.restype = ctypes.c_void_p
_u32.GetClipboardData.argtypes = [ctypes.c_uint]

# Python 3.12 的 ctypes.wintypes 里只有 _COORD，没有 COORD
COORD = getattr(wt, "COORD", None) or getattr(wt, "_COORD")

# 输入法：注入的按键会被中文 IME 改写（`>`→`》`、回车只提交候选词），
# 因此打字一律走剪贴板粘贴，并在打字期间临时摘掉目标窗口的 IME。
_imm32 = None
try:
    _imm32 = ctypes.windll.imm32
    _imm32.ImmAssociateContext.restype = ctypes.c_void_p
    _imm32.ImmAssociateContext.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
except Exception:
    _imm32 = None


def ime_detach(hwnd):
    if _imm32 is None or not hwnd:
        return None
    try:
        return _imm32.ImmAssociateContext(ctypes.c_void_p(int(hwnd)), None)
    except Exception:
        return None


def ime_attach(hwnd, previous):
    if _imm32 is None or not hwnd or not previous:
        return
    try:
        _imm32.ImmAssociateContext(ctypes.c_void_p(int(hwnd)), ctypes.c_void_p(previous))
    except Exception:
        pass


def _set_dpi_awareness():
    attempts = (
        (lambda: _u32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)), "per-monitor-v2"),
        (lambda: ctypes.windll.shcore.SetProcessDpiAwareness(2), "per-monitor"),
        (lambda: _u32.SetProcessDPIAware(), "system"),
    )
    for call, label in attempts:
        try:
            if call():
                return label
        except Exception:
            continue
    return "unaware"


DPI_AWARENESS = _set_dpi_awareness()

import pyautogui  # noqa: E402
import uiautomation as auto  # noqa: E402
import win32gui  # noqa: E402
import win32process  # noqa: E402
from PIL import Image, ImageGrab  # noqa: E402

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.02

# 屏幕角落的 fail-safe 是给人手动中断脚本用的；这里由插件驱动，
# 但光标恰好停在角落时连键盘注入都会被误判成「人想中断」，
# 所以关掉它，并在每次注入前用 ctypes 把光标挪出角落（不经过 pyautogui）。

SW_RESTORE = 9
SW_SHOW = 5
WM_CLOSE = 0x0010
CREATE_NEW_CONSOLE = 0x00000010

# ── 基础工具 ────────────────────────────────────────────────────────────────


def _window_pid(hwnd):
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return pid
    except Exception:
        return 0


def _exe_of(pid):
    try:
        h = _k32.OpenProcess(0x1000, False, pid)
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wt.DWORD(1024)
            if _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return buf.value
        finally:
            _k32.CloseHandle(h)
    except Exception:
        pass
    return ""


def _rect(hwnd):
    try:
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        return {"x": left, "y": top, "width": right - left, "height": bottom - top}
    except Exception:
        return None


def _is_minimized(hwnd):
    try:
        return bool(_u32.IsIconic(hwnd))
    except Exception:
        return False


def describe(hwnd):
    pid = _window_pid(hwnd)
    exe = _exe_of(pid)
    return {
        "hwnd": int(hwnd),
        "pid": int(pid),
        "title": win32gui.GetWindowText(hwnd) if win32gui.IsWindow(hwnd) else "",
        "class": win32gui.GetClassName(hwnd) if win32gui.IsWindow(hwnd) else "",
        "process": exe.rsplit("\\", 1)[-1] if exe else "",
        "exe": exe,
        "rect": _rect(hwnd),
        "minimized": _is_minimized(hwnd),
        "visible": bool(_u32.IsWindowVisible(hwnd)),
        "foreground": int(_u32.GetForegroundWindow()) == int(hwnd),
    }


def enum_windows(include_invisible=False):
    found = []

    def cb(hwnd, _):
        try:
            if not include_invisible and not _u32.IsWindowVisible(hwnd):
                return True
            title = win32gui.GetWindowText(hwnd)
            if not title:
                return True
            found.append(describe(hwnd))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(cb, None)
    return found


def _match_pattern(value, pattern):
    """pattern 支持 JS 风格 /regex/flags、/regex/ 或普通子串（大小写不敏感）。

    注意：`/ZCode/i` 这种带 flags 的写法必须按正则处理 —— 早期只认 `/regex/`，
    于是 `/ZCode/i` 被当作字面子串，永远匹配不到窗口（GUI 目标全部 attach 失败）。
    """
    if not pattern:
        return None
    match = re.match(r"^/(.*)/([A-Za-z]*)$", pattern)
    if match:
        body, flags = match.group(1), match.group(2)
        re_flags = re.IGNORECASE if "i" in flags else 0
        try:
            return bool(re.search(body, value, re_flags))
        except re.error:
            return False
    return pattern.lower() in value.lower()


def find_windows(title="", process="", pid=None):
    scored = []
    for w in enum_windows():
        if pid is not None and int(w["pid"]) != int(pid):
            continue
        if title and not _match_pattern(w["title"], title):
            continue
        if process and not _match_pattern(w["process"], process):
            continue
        score = 0.0
        if w["foreground"]:
            score += 100
        if title and w["title"].lower() == str(title).lower():
            score += 30
        if title and _match_pattern(w["title"], title):
            score += 20
        rect = w["rect"] or {}
        score += min((rect.get("width", 0) * rect.get("height", 0)) / 200000.0, 20)
        if w["minimized"]:
            score -= 5
        scored.append((score, w))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [w for _, w in scored]


# ── 聚焦 ────────────────────────────────────────────────────────────────────


def focus_window(hwnd):
    hwnd = int(hwnd)
    if not win32gui.IsWindow(hwnd):
        raise ValueError("hwnd %d is not a window" % hwnd)
    if _is_minimized(hwnd):
        _u32.ShowWindow(hwnd, SW_RESTORE)
    else:
        _u32.ShowWindow(hwnd, SW_SHOW)
    target_thread = _u32.GetWindowThreadProcessId(hwnd, None)
    current_thread = _k32.GetCurrentThreadId()
    foreground = _u32.GetForegroundWindow()
    foreground_thread = _u32.GetWindowThreadProcessId(foreground, None) if foreground else 0
    attached = []
    try:
        for thread in (foreground_thread, target_thread):
            if thread and thread != current_thread:
                if _u32.AttachThreadInput(current_thread, thread, True):
                    attached.append(thread)
        _u32.BringWindowToTop(hwnd)
        _u32.SetForegroundWindow(hwnd)
    finally:
        for thread in attached:
            _u32.AttachThreadInput(current_thread, thread, False)
    time.sleep(0.12)
    ok = int(_u32.GetForegroundWindow()) == hwnd
    if not ok:
        # 某些前台锁定策略下 SetForegroundWindow 会被拒绝；退化用 SetActiveWindow 再试一次。
        _u32.SetActiveWindow(hwnd)
        time.sleep(0.08)
        ok = int(_u32.GetForegroundWindow()) == hwnd
    return {"hwnd": hwnd, "focused": ok, "foreground": int(_u32.GetForegroundWindow())}


# ── 读文本：UI Automation ───────────────────────────────────────────────────

UIA_MAX_NODES = 6000


def _uia_text(node, limit, max_nodes=UIA_MAX_NODES):
    chunks = []
    total = 0
    nodes = 0

    def walk(current, depth):
        nonlocal total, nodes
        if depth > 24 or nodes > max_nodes or total > limit:
            return
        nodes += 1
        try:
            name = current.Name
            if name:
                chunks.append("  " * min(depth, 8) + name)
                total += len(name) + depth
        except Exception:
            pass
        # TextPattern：终端/富文本控件把可见文本暴露在这里
        try:
            if current.IsTextPatternAvailable():
                text = current.GetTextPattern().DocumentRange.GetText(min(limit, 20000))
                if text and text.strip():
                    chunks.append(text)
                    total += len(text)
        except Exception:
            pass
        try:
            children = current.GetChildren()
        except Exception:
            children = []
        for child in children:
            walk(child, depth + 1)

    walk(node, 0)
    deduped = []
    for chunk in chunks:
        if not deduped or deduped[-1] != chunk:
            deduped.append(chunk)
    return "\n".join(deduped)[:limit]


def read_uia(hwnd, limit):
    try:
        control = auto.ControlFromHandle(int(hwnd))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": "ControlFromHandle failed: %s" % exc}
    if control is None:
        return {"ok": False, "error": "no UIA control for hwnd %s" % hwnd}
    try:
        text = _uia_text(control, limit)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": "UIA walk failed: %s" % exc}
    return {"ok": True, "text": text}


# ── 读文本：控制台屏幕缓冲区（终端）────────────────────────────────────────


def read_console(pid, limit=20000):
    """AttachConsole 到目标进程并读它的真实屏幕缓冲区（无需 OCR、无需截图）。"""
    pid = int(pid)
    had_console = bool(_k32.GetConsoleWindow())
    _k32.FreeConsole()
    try:
        if not _k32.AttachConsole(pid):
            err = ctypes.get_last_error()
            return {"ok": False, "error": "AttachConsole(%d) failed (err=%d)" % (pid, err)}
        handle = _k32.CreateFileW("CONOUT$", 0xC0000000, 3, None, 3, 0, None)
        if handle in (-1, 0xFFFFFFFFFFFFFFFF):
            return {"ok": False, "error": "cannot open CONOUT$"}
        try:
            info = ctypes.create_string_buffer(22)
            if not _k32.GetConsoleScreenBufferInfo(handle, info):
                return {"ok": False, "error": "GetConsoleScreenBufferInfo failed"}
            import struct

            size = struct.unpack_from("<hh", info.raw, 0)
            cols, rows = int(size[0]), int(size[1])
            if cols <= 0 or rows <= 0:
                return {"ok": False, "error": "empty console buffer (%dx%d)" % (cols, rows)}
            count = cols * rows
            buffer = ctypes.create_unicode_buffer(count)
            read = wt.DWORD(0)
            coord = COORD(0, 0)
            if not _k32.ReadConsoleOutputCharacterW(handle, buffer, ctypes.c_uint32(count), coord, ctypes.byref(read)):
                return {"ok": False, "error": "ReadConsoleOutputCharacterW failed"}
            text = buffer[: read.value]
            lines = [text[i : i + cols].rstrip() for i in range(0, len(text), cols)]
            while lines and not lines[-1].strip():
                lines.pop()
            out = "\n".join(lines)[-limit:]
            return {"ok": True, "text": out, "cols": cols, "rows": rows}
        finally:
            _k32.CloseHandle(handle)
    finally:
        _k32.FreeConsole()
        if had_console:
            _k32.AllocConsole()


def cmd_text(req):
    hwnd = req.get("hwnd")
    mode = str(req.get("mode") or "auto")
    limit = int(req.get("limit") or 8000)
    out = {"hwnd": hwnd, "mode": mode}
    uia = {"ok": False, "error": "skipped"}
    if mode in ("auto", "uia") and hwnd:
        uia = read_uia(int(hwnd), limit)
        out["uia"] = uia
    console = {"ok": False, "error": "skipped"}
    if mode in ("auto", "console"):
        pid = req.get("pid") or (_window_pid(int(hwnd)) if hwnd else None)
        if pid:
            console = read_console(int(pid), limit)
            if console.get("ok") and not console.get("text", "").strip():
                console = {"ok": False, "error": "console buffer empty"}
            out["console"] = console
    uia_text = uia.get("text", "") if uia.get("ok") else ""
    console_text = console.get("text", "") if console.get("ok") else ""
    # 控制台缓冲区里就是屏幕上那几行真实文本；UIA 对终端窗口往往只给标题栏按钮
    # （实测 113 字的窗口装饰 vs 46 字的真实终端内容），所以只要控制台读到了就优先它。
    if mode == "console" or console_text.strip():
        out["text"] = console_text
        out["source"] = "console"
    else:
        out["text"] = uia_text
        out["source"] = "uia" if uia_text else "none"
    if not str(out["text"]).strip():
        out["note"] = (
            "no text could be read from this window via UI Automation or the console buffer; "
            "the harness window may not expose accessibility text — use cmd=shot and read the image"
        )
    return out


# ── 截图（兜底）─────────────────────────────────────────────────────────────


def _print_window(hwnd):
    """PrintWindow(PW_RENDERFULLCONTENT)：拍窗口自己的内容，被遮挡也有效。"""
    import win32ui

    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        raise ValueError("window has no size")
    window_dc = win32gui.GetWindowDC(hwnd)
    try:
        source = win32ui.CreateDCFromHandle(window_dc)
        memory = source.CreateCompatibleDC()
        bitmap = win32ui.CreateBitmap()
        bitmap.CreateCompatibleBitmap(source, width, height)
        memory.SelectObject(bitmap)
        try:
            if not _u32.PrintWindow(hwnd, memory.GetSafeHdc(), 2):
                raise RuntimeError("PrintWindow returned 0")
            info = bitmap.GetInfo()
            bits = bitmap.GetBitmapBits(True)
            image = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), bits, "raw", "BGRX", 0, 1)
            return image.copy()
        finally:
            win32gui.DeleteObject(bitmap.GetHandle())
            memory.DeleteDC()
            source.DeleteDC()
    finally:
        win32gui.ReleaseDC(hwnd, window_dc)


def cmd_shot(req):
    hwnd = req.get("hwnd")
    region = req.get("region")
    path = req.get("path")
    if not path:
        raise ValueError("cmd=shot requires path")
    max_width = int(req.get("max_width") or 1400)
    if hwnd:
        rect = _rect(int(hwnd))
        if not rect or rect["width"] <= 0 or rect["height"] <= 0:
            raise ValueError("window %s has no usable rect" % hwnd)
        box = (rect["x"], rect["y"], rect["x"] + rect["width"], rect["y"] + rect["height"])
    elif region:
        values = [int(round(float(v))) for v in region]
        box = (values[0], values[1], values[0] + values[2], values[1] + values[3])
    else:
        raise ValueError("cmd=shot needs hwnd or region")
    image = None
    if hwnd:
        # 优先 PrintWindow(PW_RENDERFULLCONTENT)：被遮挡的窗口也能拍到自己的内容
        # （屏幕区域抓取会把挡在前面的浏览器拍进去）。
        try:
            image = _print_window(int(hwnd))
        except Exception:
            image = None
    if image is None:
        image = ImageGrab.grab(bbox=box, all_screens=True)
    full_width, full_height = image.size
    if max_width > 0 and full_width > max_width:
        ratio = max_width / float(full_width)
        image = image.resize((max_width, max(1, int(round(full_height * ratio)))), 1)
    image.convert("RGB").save(path, "PNG")
    return {
        "path": path,
        "width": image.size[0],
        "height": image.size[1],
        "region": {"x": box[0], "y": box[1], "width": box[2] - box[0], "height": box[3] - box[1]},
    }


# ── 元素定位（GUI harness 发消息的前提：先点中它的输入框）────────────────────

INPUT_TYPES = ("EditControl", "DocumentControl")
INTERACTIVE_TYPES = ("EditControl", "DocumentControl", "ButtonControl", "HyperlinkControl", "ComboBoxControl")


def _elements(hwnd, limit=4000):
    """把窗口的 UIA 树摊平成一维元素表（带屏幕矩形），供定位/诊断用。"""
    control = auto.ControlFromHandle(int(hwnd))
    if control is None:
        return []
    found = []

    def rec(node, depth):
        if depth > 24 or len(found) >= limit:
            return
        try:
            rect = node.BoundingRectangle
            found.append({
                "ct": node.ControlTypeName,
                "name": (node.Name or "")[:200],
                "aid": node.AutomationId or "",
                "class": node.ClassName or "",
                "enabled": bool(node.IsEnabled),
                "offscreen": bool(node.IsOffscreen),
                "rect": [rect.left, rect.top, rect.width(), rect.height()],
            })
        except Exception:
            pass
        try:
            children = node.GetChildren()
        except Exception:
            children = []
        for child in children:
            rec(child, depth + 1)

    rec(control, 0)
    return found


def _window_rect(hwnd):
    return _rect(int(hwnd)) or {"x": 0, "y": 0, "width": 0, "height": 0}


def _input_candidates(hwnd, name_pattern=""):
    """挑出窗口内真正可点的输入框：可见、可用、有面积、位于窗口内；聊天输入框通常在窗口下半部。"""
    window = _window_rect(hwnd)
    picked = []
    for element in _elements(hwnd):
        if element["ct"] not in INPUT_TYPES or not element["enabled"] or element["offscreen"]:
            continue
        left, top, width, height = element["rect"]
        if width < 120 or height < 16:
            continue
        if left < window["x"] - 4 or top < window["y"] - 4:
            continue
        if left + width > window["x"] + window["width"] + 4:
            continue
        if top + height > window["y"] + window["height"] + 4:
            continue
        if name_pattern and not _match_pattern(element["name"], name_pattern):
            continue
        center_y = top + height / 2.0
        lower_half = center_y > window["y"] + window["height"] * 0.45
        score = width * height
        if element["ct"] == "EditControl":
            score *= 2.0
        if lower_half:
            score *= 1.6
        if element["name"]:
            score *= 1.05
        picked.append((score, element))
    picked.sort(key=lambda item: item[0], reverse=True)
    return [element for _, element in picked]


def cmd_input(req):
    """找到窗口里最像"聊天输入框"的元素，点中它，返回证据（含候选清单）。不找到也不算错。"""
    hwnd = int(req["hwnd"])
    candidates = _input_candidates(hwnd, str(req.get("name") or ""))
    if not candidates:
        interactive = [e for e in _elements(hwnd) if e["ct"] in INTERACTIVE_TYPES and e["enabled"]][:8]
        return {
            "found": False,
            "reason": "no enabled, visible Edit/Document control with usable size inside the window",
            "interactive_sample": interactive,
        }
    target = candidates[0]
    left, top, width, height = target["rect"]
    x, y = int(left + width / 2), int(top + height / 2)
    pyautogui.click(x, y)
    time.sleep(float(req.get("settle_ms") or 180) / 1000.0)
    return {
        "found": True,
        "clicked": {"x": x, "y": y},
        "element": target,
        "candidates": candidates[:5],
    }


def cmd_click_name(req):
    """按可见名字点击窗口内的元素（优先按钮类、面积最小者），返回点了谁。"""
    hwnd = int(req["hwnd"])
    name = str(req.get("name") or "")
    if not name:
        raise ValueError("cmd=click_name requires name")
    kind = str(req.get("kind") or "")
    window = _window_rect(hwnd)
    hits = []
    for element in _elements(hwnd):
        if not element["enabled"] or element["offscreen"]:
            continue
        if not _match_pattern(element["name"], name):
            continue
        if kind and element["ct"] != kind:
            continue
        left, top, width, height = element["rect"]
        if width < 4 or height < 4:
            continue
        # 元素必须落在目标窗口里，避免点到别的窗口
        if left + width < window["x"] or top + height < window["y"]:
            continue
        if left > window["x"] + window["width"] or top > window["y"] + window["height"]:
            continue
        exact = element["name"].strip().lower() == name.strip().lower()
        # 精确匹配优先；同类里取面积最小（最内层的那个可点元素）
        score = (0 if exact else 1000000) + width * height
        if element["ct"] == "ButtonControl":
            score -= 100000
        hits.append((score, element, left, top, width, height))
    if not hits:
        sample = [e["name"] for e in _elements(hwnd) if e["name"]][:15]
        return {"found": False, "reason": "no element matched %r" % name, "sample": sample}
    hits.sort(key=lambda item: item[0])
    _, element, left, top, width, height = hits[0]
    x, y = int(left + width / 2), int(top + height / 2)
    pyautogui.click(x, y)
    time.sleep(float(req.get("settle_ms") or 300) / 1000.0)
    return {
        "found": True,
        "clicked": {"x": x, "y": y},
        "element": {"ct": element["ct"], "name": element["name"][:120], "rect": element["rect"]},
        "alternatives": [h[1]["name"][:60] for h in hits[1:4]],
    }


def cmd_elements(req):
    hwnd = int(req["hwnd"])
    kind = str(req.get("kind") or "interactive")
    limit = int(req.get("limit") or 30)
    everything = _elements(hwnd)
    if kind == "all":
        selected = everything
    elif kind == "input":
        selected = _input_candidates(hwnd, str(req.get("name") or ""))
    else:
        selected = [e for e in everything if e["ct"] in INTERACTIVE_TYPES and e["enabled"]]
    # 去重（同一元素可能被多层包装）
    unique = []
    seen = set()
    for element in selected:
        key = (element["ct"], element["name"], tuple(element["rect"]))
        if key in seen:
            continue
        seen.add(key)
        unique.append(element)
    return {"count": len(everything), "selected": unique[:limit]}


# ── 输入注入 ────────────────────────────────────────────────────────────────

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


def _clipboard_get():
    if not _u32.OpenClipboard(None):
        return None
    try:
        if not _u32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return None
        handle = _u32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        ptr = _k32.GlobalLock(handle)
        if not ptr:
            return None
        try:
            return ctypes.wstring_at(ptr)
        finally:
            _k32.GlobalUnlock(handle)
    finally:
        _u32.CloseClipboard()


def _clipboard_set(text):
    if not _u32.OpenClipboard(None):
        raise RuntimeError("OpenClipboard failed")
    try:
        _u32.EmptyClipboard()
        buffer = ctypes.create_unicode_buffer(text)
        size = ctypes.sizeof(buffer)
        handle = _k32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not handle:
            raise RuntimeError("GlobalAlloc failed")
        ptr = _k32.GlobalLock(handle)
        if not ptr:
            raise RuntimeError("GlobalLock failed")
        ctypes.memmove(ptr, buffer, size)
        _k32.GlobalUnlock(handle)
        if not _u32.SetClipboardData(CF_UNICODETEXT, handle):
            raise RuntimeError("SetClipboardData failed")
    finally:
        _u32.CloseClipboard()


def _park_cursor():
    """把光标挪到虚拟桌面中心附近，避免停在角落（并让注入有个稳定起点）。"""
    try:
        _u32.SetCursorPos(
            _u32.GetSystemMetrics(76) + _u32.GetSystemMetrics(78) // 2,
            _u32.GetSystemMetrics(77) + _u32.GetSystemMetrics(80) // 2,
        )
    except Exception:
        pass


def cmd_type(req):
    text = req.get("text")
    if not isinstance(text, str) or text == "":
        raise ValueError("cmd=type requires a non-empty text")
    # 一律剪贴板粘贴：pyautogui.write 逐键注入会被本机中文 IME 改写（`>`→`》`、`\`→`、`、
    # 空格被吃、回车只提交候选词），粘贴则与原输入法状态无关。
    hwnd = req.get("hwnd") or _u32.GetForegroundWindow()
    previous_ime = ime_detach(hwnd)
    previous_clip = _clipboard_get()
    pasted = False
    _park_cursor()
    try:
        _clipboard_set(text)
        time.sleep(0.06)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(float(req.get("settle_ms") or 150) / 1000.0)
        pasted = True
    finally:
        ime_attach(hwnd, previous_ime)
        if previous_clip is not None:
            try:
                _clipboard_set(previous_clip)
            except Exception:
                pass
    return {"chars": len(text), "pasted": pasted, "ime_detached": previous_ime is not None}


def cmd_key(req):
    keys = req.get("keys")
    if isinstance(keys, str):
        keys = [part.strip() for part in keys.split("+") if part.strip()]
    if not isinstance(keys, list) or not keys:
        raise ValueError('cmd=key requires keys (e.g. ["ctrl","c"] or "enter")')
    keys = ["win" if key.lower() in ("cmd", "meta", "super") else key for key in keys]
    repeats = max(1, int(req.get("repeats") or 1))
    _park_cursor()
    for _ in range(repeats):
        if len(keys) > 1:
            pyautogui.hotkey(*keys)
        else:
            pyautogui.press(keys[0])
        time.sleep(0.04)
    return {"keys": keys, "repeats": repeats}


def cmd_click(req):
    x, y = int(round(float(req["x"]))), int(round(float(req["y"])))
    button = str(req.get("button") or "left")
    clicks = int(req.get("clicks") or 1)
    pyautogui.click(x, y, clicks=clicks, interval=0.06, button=button)
    return {"point": {"x": x, "y": y}, "button": button, "clicks": clicks}


# ── 启动 / 关闭窗口 ─────────────────────────────────────────────────────────


def wait_for_window(title="", process="", pid=None, timeout_ms=20000):
    deadline = time.time() + max(0.5, timeout_ms / 1000.0)
    while time.time() < deadline:
        matches = find_windows(title=title, process=process, pid=pid)
        for candidate in matches:
            rect = candidate.get("rect") or {}
            if rect.get("width", 0) > 40 and rect.get("height", 0) > 40:
                return candidate
        time.sleep(0.4)
    return None


def cmd_launch(req):
    command = req.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("cmd=launch requires command")
    mode = str(req.get("mode") or "terminal")
    title = req.get("title")
    cwd = req.get("cwd") or None
    if mode == "gui":
        proc = subprocess.Popen(command, cwd=cwd, shell=False)
    else:
        # 独立的 Windows Terminal 窗口（-w -1 = 强制新窗口），窗口标题便于后续定位。
        wt_args = ["wt.exe", "-w", "-1"]
        if title:
            wt_args += ["--title", title]
        wt_args += ["cmd.exe", "/k", command]
        try:
            proc = subprocess.Popen(wt_args, cwd=cwd, creationflags=CREATE_NEW_CONSOLE)
            host = "wt"
        except Exception:
            proc = subprocess.Popen(
                ["conhost.exe", "cmd.exe", "/k", command],
                cwd=cwd,
                creationflags=CREATE_NEW_CONSOLE,
            )
            host = "conhost"
    window = wait_for_window(
        title=title or "",
        pid=None if title else proc.pid,
        timeout_ms=int(req.get("wait_ms") or 20000),
    )
    return {"pid": proc.pid, "host": host if mode != "gui" else "gui", "window": window}


def cmd_close(req):
    hwnd = req.get("hwnd")
    if not hwnd:
        raise ValueError("cmd=close requires hwnd")
    _u32.PostMessageW(int(hwnd), WM_CLOSE, 0, 0)
    return {"hwnd": int(hwnd), "closed": True}


# ── 派发 ────────────────────────────────────────────────────────────────────


def cmd_sleep(req):
    ms = float(req.get("ms") or 100)
    time.sleep(max(0.0, ms) / 1000.0)
    return {"slept_ms": ms}


def cmd_info(_req):
    cursor = wt.POINT()
    _u32.GetCursorPos(ctypes.byref(cursor))
    return {
        "dpi_awareness": DPI_AWARENESS,
        "python": sys.version.split()[0],
        "uiautomation": getattr(auto, "__version__", "unknown"),
        "pyautogui": getattr(pyautogui, "__version__", "unknown"),
        "cursor": {"x": cursor.x, "y": cursor.y},
        "foreground": describe(_u32.GetForegroundWindow()) if _u32.GetForegroundWindow() else None,
        "virtual": {
            "x": _u32.GetSystemMetrics(76),
            "y": _u32.GetSystemMetrics(77),
            "width": _u32.GetSystemMetrics(78),
            "height": _u32.GetSystemMetrics(79),
        },
    }


COMMANDS = {
    "info": cmd_info,
    "windows": lambda req: {"windows": enum_windows(bool(req.get("include_invisible")))},
    "find": lambda req: {
        "windows": find_windows(
            title=str(req.get("title") or ""),
            process=str(req.get("process") or ""),
            pid=req.get("pid"),
        )
    },
    "focus": lambda req: focus_window(req["hwnd"]),
    "text": cmd_text,
    "elements": cmd_elements,
    "click_name": cmd_click_name,
    "input": cmd_input,
    "shot": cmd_shot,
    "type": cmd_type,
    "key": cmd_key,
    "click": cmd_click,
    "launch": cmd_launch,
    "close": cmd_close,
    "sleep": cmd_sleep,
}


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    emit({
        "hello": "dsh-harness-pilot",
        "python": sys.version.split()[0],
        "dpi_awareness": DPI_AWARENESS,
        "commands": sorted(COMMANDS),
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("id")
            handler = COMMANDS.get(req.get("cmd"))
            if handler is None:
                raise ValueError("unknown cmd %r; known: %s" % (req.get("cmd"), sorted(COMMANDS)))
            result = handler(req) or {}
            result["id"] = request_id
            result["ok"] = True
            emit(result)
        except Exception as exc:  # noqa: BLE001 - 单条请求失败不能拖垮常驻进程
            emit({"id": request_id, "ok": False, "error": "%s: %s" % (type(exc).__name__, exc)})


if __name__ == "__main__":
    main()
