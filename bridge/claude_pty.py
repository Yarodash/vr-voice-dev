"""The real interactive Claude Code, run inside a pseudo-terminal."""
import json
import logging
import re
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path

from bridge.config import ClaudeConfig

log = logging.getLogger(__name__)

VR_MARKER = "VR_VOICE_SESSION: промпты приходят голосом из VR-шлема. Следуй разделу «VR-режим» в CLAUDE.md."

_ANSI = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"          # CSI: cursor moves, colours, modes
    r"|\x1b\].*?(?:\x07|\x1b\\)"        # OSC: titles, hyperlinks
    r"|\x1b[@-Z\\-_]",                  # two-character escapes
    re.DOTALL,
)


def transcripts_dir_for(cwd: Path, home: Path | None = None) -> Path:
    """Where Claude Code keeps session transcripts for a working directory."""
    home = home or Path.home()
    return home / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))


def load_or_create_session(state_file: Path, transcripts_dir: Path, fork_from: str = "") -> tuple[str, bool]:
    """Returns (session_id, is_new). A session is resumable only once its transcript exists.

    The saved session is reused only if it was started from the same source conversation;
    changing `fork_from` in the config therefore starts a fresh copy.
    """
    state_file = Path(state_file)
    session_id = None
    if state_file.exists():
        saved = json.loads(state_file.read_text(encoding="utf-8"))
        if saved.get("forked_from", "") == fork_from:
            session_id = saved["session_id"]
    if session_id is None:
        session_id = str(uuid.uuid4())
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps({"session_id": session_id, "forked_from": fork_from}), encoding="utf-8")
    return session_id, not (Path(transcripts_dir) / f"{session_id}.jsonl").exists()


def build_claude_argv(cfg: ClaudeConfig, session_id: str, is_new: bool, settings_file: Path) -> list[str]:
    # Never `--continue`: it would pick up whichever conversation was last used in this folder.
    if not is_new:
        session = ["--resume", session_id]
    elif cfg.fork_from:
        # A copy of another conversation under our own id; the original is only read.
        session = ["--resume", cfg.fork_from, "--fork-session", "--session-id", session_id]
    else:
        session = ["--session-id", session_id]
    argv = ["claude", *session, "--settings", str(settings_file)]
    if cfg.model:
        argv += ["--model", cfg.model]
    if cfg.effort:
        argv += ["--effort", cfg.effort]
    return [*argv, "--append-system-prompt", VR_MARKER, *cfg.extra_args]


def child_env(environ: Mapping[str, str]) -> dict[str, str]:
    """Drops the variables that mark "running inside another Claude Code session"."""

    def is_session_marker(name: str) -> bool:
        upper = name.upper()
        return upper in ("CLAUDECODE", "CLAUDE_PID") or upper.startswith("CLAUDE_CODE_")

    return {k: v for k, v in environ.items() if not is_session_marker(k)}


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


class ListeningDetector:
    """Spots the `listening…` footer that Claude Code shows once dictation is recording."""

    WORD = "listening"
    _TAIL = 64

    def __init__(self):
        self._armed = False
        self._seen = False
        self._tail = ""

    def reset(self) -> None:
        self._armed, self._seen, self._tail = True, False, ""

    def feed(self, text: str) -> bool:
        if not self._armed:
            return False
        if not self._seen:
            combined = self._tail + text
            self._seen = self.WORD in strip_ansi(combined)
            self._tail = combined[-self._TAIL:]
        return self._seen


class PtyHost:
    def __init__(
        self,
        argv: list[str],
        cwd: str,
        env: Mapping[str, str] | None,
        cols: int,
        rows: int,
        on_output: Callable[[str], None],
        replay_limit: int = 200_000,
        on_exit: Callable[[], None] | None = None,
    ):
        self._argv, self._cwd, self._env = argv, cwd, env
        self._cols, self._rows = cols, rows
        self._on_output, self._on_exit = on_output, on_exit
        self._replay_limit = replay_limit
        self._replay = ""
        self._lock = threading.Lock()
        self._proc = None

    def start(self) -> None:
        from winpty import PtyProcess

        self._proc = PtyProcess.spawn(self._argv, cwd=self._cwd, env=self._env, dimensions=(self._rows, self._cols))
        threading.Thread(target=self._read_loop, name="pty-reader", daemon=True).start()

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.isalive()

    def write(self, data: str) -> None:
        with self._lock:
            if self.alive:
                self._proc.write(data)

    def replay(self) -> str:
        with self._lock:
            return self._replay

    def nudge_redraw(self) -> None:
        """Resizes by one row and back, which makes a full-screen program repaint everything."""
        if not self.alive:
            return
        self._proc.setwinsize(self._rows - 1, self._cols)
        time.sleep(0.05)
        self._proc.setwinsize(self._rows, self._cols)

    def stop(self) -> None:
        proc = self._proc
        if proc is not None and proc.isalive():
            try:
                proc.terminate(force=True)
            except Exception:
                log.exception("could not terminate the terminal process")

    def _remember(self, data: str) -> None:
        with self._lock:
            self._replay = (self._replay + data)[-self._replay_limit:]

    def _read_loop(self) -> None:
        proc = self._proc
        try:
            while True:
                data = proc.read(4096)
                if data:
                    self._remember(data)
                    self._on_output(data)
        except EOFError:
            pass
        except Exception:
            log.exception("terminal reader stopped")
        if self._on_exit is not None:
            self._on_exit()
