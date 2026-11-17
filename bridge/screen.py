"""The hidden terminal's screen as the bridge sees it (pyte), for things the bridge has to
read off the rendered screen rather than the raw output.

Claude Code repaints only the cells that changed, so a word on screen may never appear whole in
the raw stream: after "keep holding…" the footer turns into "listening…" by writing "listning…".
"""
import threading

import pyte

_ALT_SCREEN = 1049


class _Screen(pyte.Screen):
    """pyte has no alternate screen; switching to/from it at least starts from a clean page."""

    def set_mode(self, *modes, **kwargs):
        if kwargs.get("private") and _ALT_SCREEN in modes:
            self.erase_in_display(2)
        super().set_mode(*modes, **kwargs)

    def reset_mode(self, *modes, **kwargs):
        if kwargs.get("private") and _ALT_SCREEN in modes:
            self.erase_in_display(2)
        super().reset_mode(*modes, **kwargs)


class TerminalScreen:
    """Thread-safe: fed from the terminal reader thread, read from the asyncio loop."""

    def __init__(self, cols: int, rows: int):
        self._lock = threading.Lock()
        self._screen = _Screen(cols, rows)
        self._stream = pyte.Stream(self._screen)

    def feed(self, text: str) -> None:
        with self._lock:
            self._stream.feed(text)

    def text(self) -> str:
        with self._lock:
            return "\n".join(line.rstrip() for line in self._screen.display)
