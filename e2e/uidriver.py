"""
uidriver.py - a thin, dependency-light UI automation driver for the two
DocWellness Flutter apps, built on `adb` + `uiautomator dump`.

Why not uiautomator2 / Appium: the emulators run a very recent Android build
whose window internals break uiautomator2's bundled jsonrpc stub
("ApplicationSharedMemory not initialized"). The platform's own
`adb shell uiautomator dump` works fine, and Flutter exposes its semantics
tree through the Android accessibility node `content-desc`, so selecting by
description + tapping bounds centres is reliable.

Everything here is deliberately synchronous and screenshot-heavy so a failed
run leaves a visual trail in e2e/artifacts/.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime

ARTIFACT_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
os.makedirs(ARTIFACT_DIR, exist_ok=True)

# Prefer the platform-tools adb that ships with the Android SDK; fall back to PATH.
_SDK_ADB = os.path.expandvars(r"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe")
ADB = _SDK_ADB if os.path.exists(_SDK_ADB) else "adb"


class UiTimeout(RuntimeError):
    pass


@dataclass
class Node:
    desc: str
    text: str
    cls: str
    rid: str
    clickable: bool
    bounds: tuple[int, int, int, int]  # x1, y1, x2, y2

    @property
    def center(self) -> tuple[int, int]:
        x1, y1, x2, y2 = self.bounds
        return (x1 + x2) // 2, (y1 + y2) // 2

    @property
    def label(self) -> str:
        return (self.desc or self.text or "").replace("\n", " / ")

    def __repr__(self) -> str:
        return f"Node({self.label!r} {self.cls.split('.')[-1]} {self.bounds})"


_BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


class Device:
    def __init__(self, serial: str, run_tag: str = "", label: str = ""):
        self.serial = serial
        self.label = label or serial
        self.run_tag = run_tag or datetime.now().strftime("%Y%m%d-%H%M%S")
        self._shot_seq = 0
        self._last_nodes: list[Node] = []

    # ---- low level ------------------------------------------------------
    def adb(self, *args: str, timeout: int = 60, binary: bool = False):
        cp = subprocess.run(
            [ADB, "-s", self.serial, *args],
            capture_output=True,
            timeout=timeout,
        )
        if binary:
            return cp.stdout
        return cp.stdout.decode("utf-8", "replace"), cp.stderr.decode("utf-8", "replace")

    def shell(self, cmd: str, timeout: int = 60) -> str:
        out, _ = self.adb("shell", cmd, timeout=timeout)
        return out

    # ---- hierarchy ----------------------------------------------------
    def dump(self, retries: int = 4) -> list[Node]:
        # `uiautomator dump` waits up to ~10s for the UI to go idle, then
        # dumps anyway (spinners / videos never idle). Cap the adb call at
        # 18s so a busy screen doesn't stall the whole run for minutes.
        for attempt in range(retries):
            try:
                self.adb("shell", "uiautomator dump --compressed /sdcard/uidump.xml", timeout=18)
            except subprocess.TimeoutExpired:
                pass
            try:
                raw = self.adb("exec-out", "cat", "/sdcard/uidump.xml", binary=True, timeout=15)
            except subprocess.TimeoutExpired:
                raw = b""
            if raw and b"<hierarchy" in raw:
                try:
                    nodes = self._parse(raw)
                    if nodes:
                        self._last_nodes = nodes
                        return nodes
                except ET.ParseError:
                    pass
            time.sleep(1.0)
        raise UiTimeout(f"[{self.label}] uiautomator dump produced no usable hierarchy")

    @staticmethod
    def _parse(raw: bytes) -> list[Node]:
        # uiautomator emits an XML declaration with single quotes + a stray
        # trailing newline sometimes; ElementTree copes, but guard anyway.
        root = ET.fromstring(raw.decode("utf-8", "replace"))
        nodes: list[Node] = []
        for el in root.iter("node"):
            m = _BOUNDS_RE.match(el.attrib.get("bounds", ""))
            if not m:
                continue
            x1, y1, x2, y2 = (int(v) for v in m.groups())
            nodes.append(
                Node(
                    desc=el.attrib.get("content-desc", "") or "",
                    text=el.attrib.get("text", "") or "",
                    cls=el.attrib.get("class", "") or "",
                    rid=el.attrib.get("resource-id", "") or "",
                    clickable=el.attrib.get("clickable") == "true",
                    bounds=(x1, y1, x2, y2),
                )
            )
        return nodes

    # ---- queries ----------------------------------------------------
    def _match(
        self,
        nodes: list[Node],
        desc: str | None,
        text: str | None,
        cls: str | None,
        exact: bool,
    ) -> list[Node]:
        out = []
        for n in nodes:
            hay = n.desc if desc is not None else n.text if text is not None else None
            needle = desc if desc is not None else text
            if needle is not None:
                # Flutter often doubles a node's content-desc ("Next\nNext")
                # or packs a whole card into one ("Chole\n111 g\n415 calorie"),
                # so match the regex against the whole string OR any single
                # newline-split segment - lets `^Next$` still hit the button.
                hay = hay or ""
                parts = [hay] + [p.strip() for p in hay.split("\n") if p.strip()]
                if exact:
                    if needle not in (p.strip() for p in parts):
                        continue
                else:
                    if not any(re.search(needle, p, re.I) for p in parts):
                        continue
            if cls and not n.cls.endswith(cls):
                continue
            out.append(n)
        return out

    def find(
        self,
        desc: str | None = None,
        text: str | None = None,
        cls: str | None = None,
        exact: bool = False,
        fresh: bool = True,
    ) -> Node | None:
        nodes = self.dump() if fresh else (self._last_nodes or self.dump())
        hits = self._match(nodes, desc, text, cls, exact)
        return hits[0] if hits else None

    def find_all(self, desc=None, text=None, cls=None, exact=False, fresh=True) -> list[Node]:
        nodes = self.dump() if fresh else (self._last_nodes or self.dump())
        return self._match(nodes, desc, text, cls, exact)

    def exists(self, desc=None, text=None, **kw) -> bool:
        return self.find(desc=desc, text=text, **kw) is not None

    def wait(
        self,
        desc: str | None = None,
        text: str | None = None,
        cls: str | None = None,
        exact: bool = False,
        timeout: int = 25,
        poll: float = 1.2,
    ) -> Node:
        deadline = time.time() + timeout
        last_seen = ""
        while time.time() < deadline:
            nodes = self.dump()
            hits = self._match(nodes, desc, text, cls, exact)
            if hits:
                return hits[0]
            last_seen = " | ".join(sorted({n.label for n in nodes if n.label})[:18])
            time.sleep(poll)
        self.screenshot("TIMEOUT")
        raise UiTimeout(
            f"[{self.label}] timed out waiting for "
            f"{desc or text!r} after {timeout}s. On screen: {last_seen}"
        )

    def wait_gone(self, desc=None, text=None, timeout: int = 25, poll: float = 1.2):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.exists(desc=desc, text=text):
                return
            time.sleep(poll)
        raise UiTimeout(f"[{self.label}] {desc or text!r} still present after {timeout}s")

    # ---- actions ----------------------------------------------------
    def tap(self, node: Node, settle: float = 0.8):
        x, y = node.center
        self.adb("shell", "input", "tap", str(x), str(y))
        time.sleep(settle)

    def tap_at(self, x: int, y: int, settle: float = 0.8):
        self.adb("shell", "input", "tap", str(x), str(y))
        time.sleep(settle)

    def tap_desc(self, desc: str, exact: bool = False, timeout: int = 25, settle: float = 0.8) -> Node:
        node = self.wait(desc=desc, exact=exact, timeout=timeout)
        self.tap(node, settle=settle)
        return node

    def tap_text(self, text: str, exact: bool = False, timeout: int = 25, settle: float = 0.8) -> Node:
        node = self.wait(text=text, exact=exact, timeout=timeout)
        self.tap(node, settle=settle)
        return node

    def tap_button(self, desc: str, timeout: int = 25, settle: float = 0.8, scroll: bool = True) -> Node:
        """Tap a button by description, restricted to actual Button nodes so
        a matching word inside body text can't be hit by mistake. `desc`
        should be anchored (e.g. r'^Select Plan$')."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            hit = self.find(desc=desc, cls="Button")
            if hit:
                self.tap(hit, settle=settle)
                return hit
            if scroll:
                self.scroll_down(0.4)
            else:
                time.sleep(1)
        self.screenshot("TAPBTN_FAIL")
        raise UiTimeout(f"[{self.label}] no Button matching {desc!r}")

    def back(self, settle: float = 0.8):
        self.adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(settle)

    def hide_keyboard(self):
        # Only dismisses if one is up; harmless otherwise.
        if "mInputShown=true" in self.shell("dumpsys input_method"):
            self.back(settle=0.4)

    def clear_field(self):
        # Assumes the field is already focused. Move to end, then hammer delete.
        self.adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
        self.adb(
            "shell",
            "input",
            "keyevent",
            *(["KEYCODE_DEL"] * 60),
        )
        time.sleep(0.3)

    @staticmethod
    def _dq(value: str) -> str:
        """Wrap for the *device* shell in single quotes so nothing ($VAR,
        backticks, globs) is expanded; `input text` then gets the literal."""
        return "'" + value.replace("'", "'\\''") + "'"

    def type_text(self, value: str, per_char: bool = True):
        # per_char is the reliable default: one `input text` call per
        # character sidesteps every device-shell + `input` quirk (space
        # handling, %, symbol interpretation) at the cost of speed.
        if per_char:
            for ch in value:
                if ch == " ":
                    self.adb("shell", "input keyevent KEYCODE_SPACE")
                else:
                    self.adb("shell", f"input text {self._dq(ch)}")
                time.sleep(0.03)
        else:
            self.adb("shell", f"input text {self._dq(value)}")
        time.sleep(0.3)

    def set_field(self, node: Node, value: str, clear: bool = True):
        self.tap(node, settle=0.7)
        # a stylus/handwriting popup can appear on first focus and eat input
        if self.dismiss_popup():
            self.tap(node, settle=0.7)
        if clear:
            self.clear_field()
        # Single-shot: one `input text '<value>'`. Flutter EditTexts don't
        # surface their contents through uiautomator, so there's nothing
        # reliable to verify against - keep it simple and screenshot after.
        # Spaces survive inside the single-quoted arg on Android 7+.
        self.type_text(value, per_char=False)
        time.sleep(0.3)

    def swipe(self, x1, y1, x2, y2, ms: int = 400):
        self.adb("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(ms))
        time.sleep(0.6)

    def scroll_down(self, frac: float = 0.6):
        w, h = self.size()
        self.swipe(w // 2, int(h * 0.72), w // 2, int(h * (0.72 - frac)), 500)

    def scroll_up(self, frac: float = 0.6):
        w, h = self.size()
        self.swipe(w // 2, int(h * 0.28), w // 2, int(h * (0.28 + frac)), 500)

    def scroll_to(self, desc: str, max_swipes: int = 10, exact: bool = False,
                  frac: float = 0.6, cls: str | None = None) -> Node:
        last_sig = None
        for i in range(max_swipes):
            hit = self.find(desc=desc, exact=exact, cls=cls)
            if hit:
                return hit
            # stop early if the screen stopped changing (hit the bottom)
            sig = tuple(sorted(n.label for n in self._last_nodes if n.label))
            if sig and sig == last_sig:
                break
            last_sig = sig
            self.scroll_down(frac)
        hit = self.find(desc=desc, exact=exact, cls=cls)
        if hit:
            return hit
        self.screenshot("SCROLL_FAIL")
        raise UiTimeout(f"[{self.label}] could not scroll to {desc!r}")

    def scroll_to_end(self, swipes: int = 30, frac: float = 0.85):
        last_sig = None
        for _ in range(swipes):
            self.scroll_down(frac)
            sig = tuple(sorted(n.label for n in self.dump() if n.label))
            if sig == last_sig:
                return
            last_sig = sig

    # ---- misc ----------------------------------------------------
    def size(self) -> tuple[int, int]:
        out = self.shell("wm size")  # "Physical size: 1080x2400"
        m = re.search(r"(\d+)x(\d+)", out)
        return (int(m.group(1)), int(m.group(2))) if m else (1080, 2400)

    def current_package(self) -> str:
        out = self.shell("dumpsys activity activities | grep -E 'topResumedActivity|ResumedActivity'")
        m = re.search(r"\{[^}]*\s([\w.]+)/", out)
        return m.group(1) if m else ""

    def prep(self):
        """One-time device hygiene: kill the Android 14+ stylus-handwriting
        onboarding popup ("Try out your stylus") that otherwise steals the
        first `input text` into any field, keep the screen on, and unlock."""
        for ns, key in (
            ("secure", "stylus_handwriting_enabled"),
            ("global", "stylus_handwriting_enabled"),
            ("secure", "stylus_handwriting_default_enabled"),
        ):
            self.adb("shell", f"settings put {ns} {key} 0")
        self.adb("shell", "settings put system screen_off_timeout 1800000")
        self.adb("shell", "svc power stayon true")
        self.adb("shell", "input keyevent KEYCODE_WAKEUP")
        self.adb("shell", "wm dismiss-keyguard")

    _OVERLAY_RE = r"About Doctor|My Story|Quote of the Day|quote of the day|Maybe later|Not now|Rate us|Enjoying"

    def dismiss_overlays(self, rounds: int = 5):
        """Clear first-run / one-off overlays on top of the real screen
        (the 'About Doctor' intro card - rendered as a full-screen image
        with a tiny close-X - the quote-of-the-day dialog, rating prompts).
        Safe to call anytime; a no-op when nothing's there."""
        w, h = self.size()
        for _ in range(rounds):
            nodes = self.dump()
            labels = " ".join(n.label for n in nodes if n.label)
            has_dismiss_scrim = any(
                n.label.strip().lower() == "dismiss" and (n.bounds[2] - n.bounds[0]) > w * 0.8
                for n in nodes
            )
            if not has_dismiss_scrim and not re.search(self._OVERLAY_RE, labels, re.I):
                return
            # 1) a real, small labelled close button
            btn = next(
                (n for n in nodes
                 if re.fullmatch(r"(Dismiss|Close|Got it|Skip|Maybe later|Not now|OK|Continue)", n.label.strip(), re.I)
                 and (n.bounds[2] - n.bounds[0]) < w * 0.8),
                None,
            )
            if btn:
                self.tap(btn)
            else:
                # 2) the smallest clickable node in the bottom quarter - the
                #    bare close-X on the "About Doctor" image card
                bottom = [n for n in nodes if n.clickable and n.bounds[1] > h * 0.75
                          and (n.bounds[2] - n.bounds[0]) < w * 0.5]
                if bottom:
                    bottom.sort(key=lambda n: (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]))
                    self.tap(bottom[0])
                else:
                    # 3) last resort: poke the scrim in the top-left corner,
                    #    clear of any centred card/image
                    self.tap_at(int(w * 0.04), int(h * 0.10))
            time.sleep(1.2)

    def dismiss_popup(self):
        """Dismiss a stray system dialog (stylus onboarding, permission
        prompt) if one is covering the app. Returns True if it acted."""
        nodes = self._last_nodes or []
        for n in nodes:
            if re.search(r"stylus|handwriting", n.label, re.I):
                cancel = next((x for x in nodes if re.fullmatch(r"(Cancel|Not now|No thanks|Dismiss)", x.label.strip(), re.I)), None)
                if cancel:
                    self.tap(cancel)
                else:
                    self.back()
                return True
        return False

    def launch(self, package: str, activity: str | None = None, wait_s: float = 4.0):
        target = f"{package}/{activity}" if activity else None
        if target:
            self.adb("shell", "am", "start", "-n", target)
        else:
            self.adb("shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(wait_s)

    def stop(self, package: str):
        self.adb("shell", "am", "force-stop", package)
        time.sleep(1.0)

    def screenshot(self, name: str) -> str:
        self._shot_seq += 1
        safe = re.sub(r"[^A-Za-z0-9_-]+", "_", name)
        fname = f"{self.run_tag}__{self.label}__{self._shot_seq:02d}_{safe}.png"
        path = os.path.join(ARTIFACT_DIR, fname)
        data = self.adb("exec-out", "screencap", "-p", binary=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def debug_dump(self, limit: int = 60):
        nodes = self.dump()
        print(f"--- [{self.label}] {len(nodes)} nodes ---")
        for n in nodes:
            if n.label:
                print(f"  {n.bounds!s:>28}  {'*' if n.clickable else ' '} {n.label}")
