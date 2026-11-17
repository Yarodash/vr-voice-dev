"""`python -m bridge` — runs Claude Code in a pseudo-terminal and serves the headset page's WebSocket."""
import asyncio
import json
import logging
import os
import re
import sys
import time
import uuid
from pathlib import Path

from aiohttp import web

from bridge.audio_devices import CaptureDefaults, PycawBackend
from bridge.cert import ensure_cert
from bridge.claude_pty import (
    ListeningDetector,
    PtyHost,
    build_claude_argv,
    child_env,
    load_or_create_session,
    transcripts_dir_for,
)
from bridge.config import Config, load_config
# режим «конфиг» выключен по просьбе пользователя: все фразы идут в основную сессию (bridge/config_agent.py оставлен)
from bridge.dictation import Dictation
from bridge.screen import TerminalScreen
from bridge.server import HUB, KEYS, create_app, load_or_create_pair_code
from bridge.virtual_mic import VirtualMicPlayer

log = logging.getLogger("bridge")

# Applies to the VR session only (passed with --settings), not to the user's own Claude Code.
# Nothing is sent on release: the words pile up in the prompt until the user presses "send".
VR_CLAUDE_SETTINGS = {"voice": {"enabled": True, "mode": "hold", "autoSubmit": False}}

# Claude Code's prompt box: a long horizontal rule with the `❯` prompt line right under it.
PROMPT_BOX = re.compile(r"^─{20,}.*\n\s*[❯>]", re.M)


class ClaudeRunner:
    """Keeps one Claude Code session alive in a pseudo-terminal and restarts it if it exits."""

    def __init__(self, cfg: Config, root: Path, settings_file: Path, state_file: Path, on_output,
                 on_start=None):
        self._cfg, self._root = cfg, root
        self._settings_file, self._state_file = settings_file, state_file
        self._on_output = on_output
        self._on_start = on_start  # called (on any thread) after every start, restarts included
        self._host: PtyHost | None = None
        # The rendered screen, for what has to be read off it (the `listening…` footer).
        self.screen = TerminalScreen(cfg.terminal.cols, cfg.terminal.rows)
        self._stopping = False
        self._started = 0.0
        self._quick_exits = 0

    def start(self) -> None:
        if self._cfg.claude.fork_from:
            session_id, is_new = load_or_create_session(self._state_file, transcripts_dir_for(self._root),
                                                        self._cfg.claude.fork_from)
        else:
            # Only used as a speech recogniser: nothing to remember, so start clean every time.
            # (Resuming would also fail if a prompt ever got submitted there by accident.)
            session_id, is_new = str(uuid.uuid4()), True
        argv = build_claude_argv(self._cfg.claude, session_id, is_new, self._settings_file)
        log.info("starting Claude Code (%s session %s)", "new" if is_new else "resumed", session_id)
        screen = self.screen = TerminalScreen(self._cfg.terminal.cols, self._cfg.terminal.rows)

        def on_output(text: str) -> None:  # terminal reader thread
            screen.feed(text)
            self._on_output(text)

        self._host = PtyHost(argv, cwd=str(self._root), env=child_env(os.environ),
                             cols=self._cfg.terminal.cols, rows=self._cfg.terminal.rows,
                             on_output=on_output, on_exit=self._on_exit)
        self._started = time.monotonic()
        self._host.start()
        if self._on_start is not None:
            self._on_start()

    def write(self, data: str) -> None:
        if self._host is not None:
            self._host.write(data)

    def replay(self) -> str:
        return self._host.replay() if self._host is not None else ""

    def nudge_redraw(self) -> None:
        if self._host is not None:
            self._host.nudge_redraw()

    def stop(self) -> None:
        self._stopping = True
        if self._host is not None:
            self._host.stop()

    def _on_exit(self) -> None:  # called on the terminal reader thread
        if self._stopping:
            return
        self._quick_exits = self._quick_exits + 1 if time.monotonic() - self._started < 10 else 0
        if self._quick_exits >= 3:
            log.error("Claude Code exited three times in a row right after starting; not restarting it")
            return
        log.warning("Claude Code exited; restarting it")
        time.sleep(1)
        self.start()


async def serve(cfg: Config, root: Path) -> None:
    loop = asyncio.get_running_loop()
    state_dir = root / ".vr"
    state_dir.mkdir(exist_ok=True)
    settings_file = state_dir / "claude-settings.json"
    settings_file.write_text(json.dumps(VR_CLAUDE_SETTINGS), encoding="utf-8")
    pair_code = load_or_create_pair_code(state_dir / "pair-code")

    defaults = CaptureDefaults(PycawBackend(), cfg.audio.virtual_mic, state_dir / "default-mic.json")
    defaults.prepare()
    player = VirtualMicPlayer(cfg.audio.virtual_speaker, cfg.audio.cable_gain_db + cfg.audio.mic_gain_db)

    def deliver(text: str) -> None:
        hub.pty_output(text)
        if dictation.state == "warmup":
            # Read off the rendered screen: the raw output never has "listening" whole.
            dictation.on_pty_output(runner.screen.text())

    priming: list[asyncio.Task] = []

    def schedule_priming() -> None:  # after every (re)start of Claude Code, on any thread
        def create():
            priming[:] = [asyncio.create_task(prime_when_ready(runner.screen))]
        loop.call_soon_threadsafe(create)

    async def prime_when_ready(screen: TerminalScreen) -> None:
        # Ready = the prompt box has been on screen for a second without interruption.
        deadline = loop.time() + 60
        shown_since = None
        while loop.time() < deadline:
            if runner.screen is not screen:
                return  # restarted meanwhile: that start primes on its own
            if PROMPT_BOX.search(screen.text()):
                shown_since = shown_since or loop.time()
                if loop.time() - shown_since >= 1.0:
                    break
            else:
                shown_since = None
            await asyncio.sleep(0.1)
        else:
            log.warning("Claude Code did not show its prompt within 60 s; dictation not primed")
            return
        try:
            if not await dictation.prime():
                log.info("priming skipped: the user is dictating")
                return
            end = loop.time() + 5
            while "Transcribing" in screen.text() and loop.time() < end:
                await asyncio.sleep(0.05)
            if dictation.state == "idle":  # never wipe a dictation the user has started meanwhile
                runner.write(KEYS["clear"])
            log.info("dictation primed")
        except Exception:
            log.exception("priming failed")

    runner = ClaudeRunner(cfg, root, settings_file, state_dir / "session.json",
                          on_output=lambda text: loop.call_soon_threadsafe(deliver, text),
                          on_start=schedule_priming)
    dictation = Dictation(runner.write, ListeningDetector(), defaults, player,
                          on_state=lambda state: hub.voice_state(state),
                          on_error=lambda text: hub.voice_error(text))
    app = create_app(cfg, runner, dictation, root / "logs" / "scene-status.json", pair_code,
                     console_log=root / "logs" / "page-console.log",
                     files_dir=root / "logs" / "screenshots",
                     inbox_log=root / "logs" / "vr-inbox.log")
    hub = app[HUB]

    runner.start()
    app_runner = web.AppRunner(app)
    await app_runner.setup()
    await web.TCPSite(app_runner, "127.0.0.1", cfg.bridge_port).start()
    print(f"\n  Откройте в браузере Quest:  https://{cfg.lan_host}:{cfg.web_port}/\n"
          f"  Код сопряжения:             {pair_code}\n", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await dictation.release()
        await dictation.wait_idle()
        defaults.restore()
        runner.stop()
        await app_runner.cleanup()


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    root = Path(__file__).resolve().parent.parent
    cfg = load_config(root / "config.json")
    ensure_cert(root / "certs", [cfg.lan_host])
    try:
        asyncio.run(serve(cfg, root))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
