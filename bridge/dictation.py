"""Push-to-talk into Claude Code's built-in dictation.

While the trigger is held we "hold Space" in the terminal (terminals have no key-up event, so a
held key is just rapid repeats), make the virtual microphone the default recording device, and
play the headset's audio into it. Audio that arrives before Claude Code says `listening…` is
kept back so the first words are not lost; that backlog also absorbs network jitter afterwards.

Every wait in here has a deadline: whatever happens to the page, the terminal or the audio
device, the user's own microphone must become the default again.
"""
import asyncio
import logging
import threading
import time
from collections.abc import Callable

log = logging.getLogger(__name__)

BYTES_PER_SECOND = 48000 * 2  # 48 kHz, 16-bit mono


class Dictation:
    def __init__(
        self,
        pty_write: Callable[[str], None],
        detector,
        defaults,
        player,
        on_state: Callable[[str], None],
        *,
        on_error: Callable[[str], None] | None = None,
        repeat_s: float = 0.033,
        # Playing before Claude Code records loses the first words; it usually starts within
        # ~1 s, so this only guards against never seeing the footer.
        listen_timeout_s: float = 4.0,
        lead_in_s: float = 0.3,
        tail_s: float = 0.35,
        min_audio_s: float = 0.25,
        restore_delay_s: float = 0.5,
        min_spaces: int = 6,
        idle_audio_s: float = 3.0,
        max_hold_s: float = 120.0,
        drain_grace_s: float = 1.0,
    ):
        self._pty_write = pty_write
        self._detector = detector
        self._defaults = defaults
        self._player = player
        self._on_state = on_state
        self._on_error = on_error
        self._repeat_s = repeat_s
        self._listen_timeout_s = listen_timeout_s
        self._lead_in = b"\x00\x00" * int(48000 * lead_in_s)
        self._tail_s = tail_s
        self._min_audio_s = min_audio_s
        self._restore_delay_s = restore_delay_s
        self._min_spaces = min_spaces
        self._idle_audio_s = idle_audio_s
        self._max_hold_s = max_hold_s
        self._drain_grace_s = drain_grace_s

        self.state = "idle"
        self._task: asyncio.Task | None = None
        self._released = asyncio.Event()
        self._listening = asyncio.Event()
        self._holding = threading.Event()
        self._buffer: list[bytes] = []
        self._audio_bytes = 0
        self._streaming = False
        self._spaces = 0
        self._pressed_at = 0.0
        self._last_audio_at = 0.0
        self._priming = False

    def _busy(self) -> bool:
        return self._task is not None and not self._task.done()

    async def press(self, *, priming: bool = False) -> None:
        """`priming` is for prime() only."""
        if self._busy():
            if not self._released.is_set():
                if self._priming:  # the user pressed during the silent priming: it is theirs now
                    self._priming = False
                    log.info("priming taken over by a real press")
                    if self._on_state is not None:
                        self._on_state(self.state)
                return  # already holding
            await self.wait_idle()  # the previous dictation is still finishing
        self._priming = priming
        self._released = asyncio.Event()
        self._listening = asyncio.Event()
        # Silence before the first words (not counted as audio: a tap stays a tap).
        self._buffer = [self._lead_in] if self._lead_in else []
        self._audio_bytes, self._streaming, self._spaces = 0, False, 0
        self._pressed_at = self._last_audio_at = asyncio.get_running_loop().time()
        self._detector.reset()
        self._set_state("warmup")
        self._task = asyncio.create_task(self._run())

    def feed(self, pcm: bytes) -> None:
        if not self._busy() or self._released.is_set():
            return
        self._audio_bytes += len(pcm)
        self._last_audio_at = asyncio.get_running_loop().time()
        if self._streaming:
            self._player.feed(pcm)
        else:
            self._buffer.append(pcm)

    async def release(self) -> None:
        if self._busy():
            self._released.set()

    async def wait_idle(self) -> None:
        if self._task is not None:
            await asyncio.shield(self._task)

    async def prime(self, silence_s: float = 1.0) -> bool:
        """One silent dictation, done once after Claude Code starts: its first dictation sometimes
        lost the first words even after `listening…` was shown. Silent towards the page. A real
        press meanwhile takes the dictation over (its audio simply follows the silence); then
        this returns False and the caller must not touch the prompt."""
        if self._busy():
            return False
        await self.press(priming=True)
        loop = asyncio.get_running_loop()
        end = loop.time() + silence_s
        frame = b"\x00\x00" * 960  # 20 ms
        while self._priming and loop.time() < end:
            self.feed(frame)
            await asyncio.sleep(0.02)
        if not self._priming:
            return False
        await self.release()  # no await between the check above and this: no press can slip in
        await self.wait_idle()
        return True

    def on_pty_output(self, text: str) -> None:
        if self._busy() and not self._listening.is_set() and self._detector.feed(text):
            self._listening.set()

    def _set_state(self, state: str) -> None:
        self.state = state
        if not self._priming:  # the page does not see the silent priming
            self._on_state(state)

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        repeater = None
        try:
            await asyncio.to_thread(self._defaults.switch_to_virtual)
            await asyncio.to_thread(self._player.open)
            repeater = self._start_repeater()
            if await self._warmup():
                self._set_state("listening")
                for pcm in self._buffer:
                    self._player.feed(pcm)
                self._buffer = []
                self._streaming = True
                await self._wait_for_release()
                self._released.set()  # also after an automatic release: late audio is not played
                self._streaming = False
                deadline = loop.time() + self._player.pending_seconds() + self._drain_grace_s
                while self._player.pending_seconds() > 0 and loop.time() < deadline:
                    await asyncio.sleep(0.01)
                await asyncio.sleep(self._tail_s)
            else:
                # A stray click. Claude Code removes its own warm-up spaces once it has seen
                # enough repeats; typing backspace or Esc ourselves could eat real input.
                deadline = loop.time() + max(1.0, self._repeat_s * self._min_spaces * 3)
                while self._spaces < self._min_spaces and loop.time() < deadline:
                    await asyncio.sleep(self._repeat_s)
        except Exception as exc:
            log.exception("dictation failed")
            if self._on_error is not None:
                self._on_error(f"{type(exc).__name__}: {exc}")
        finally:
            self._released.set()
            self._streaming = False
            self._holding.clear()
            if repeater is not None:
                await asyncio.to_thread(repeater.join, 1.0)
            self._set_state("finalizing")
            await asyncio.to_thread(self._quietly, self._player.close)
            await asyncio.sleep(self._restore_delay_s)
            await asyncio.to_thread(self._quietly, self._defaults.restore)
            self._set_state("idle")
            self._priming = False

    async def _warmup(self) -> bool:
        """True: go on and stream the audio. False: the trigger was only tapped."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._listen_timeout_s
        while True:
            if self._released.is_set() and self._audio_bytes / BYTES_PER_SECOND < self._min_audio_s:
                return False
            if self._listening.is_set():
                log.info("Claude Code is listening after %.2f s", loop.time() - self._pressed_at)
                return True
            if loop.time() >= deadline:
                log.warning("did not see 'listening' within %.1f s; sending the audio anyway",
                            self._listen_timeout_s)
                return True
            await asyncio.sleep(0.005)

    async def _wait_for_release(self) -> None:
        """Returns on release, or by itself if the page stopped sending audio or held too long."""
        loop = asyncio.get_running_loop()
        while not self._released.is_set():
            now = loop.time()
            if now - self._last_audio_at > self._idle_audio_s:
                log.warning("no audio from the page for %.1f s; ending the dictation", self._idle_audio_s)
                return
            if now - self._pressed_at > self._max_hold_s:
                log.warning("trigger held for more than %.0f s; ending the dictation", self._max_hold_s)
                return
            await asyncio.sleep(0.01)

    def _start_repeater(self) -> threading.Thread:
        # A thread with time.sleep keeps the repeat interval steady; asyncio timers on Windows
        # are only accurate to ~16 ms, which is too coarse for hold detection.
        self._holding.set()

        def repeat():
            while self._holding.is_set():
                try:
                    self._pty_write(" ")
                except Exception:
                    log.exception("could not write to the terminal; stopping the key repeat")
                    return
                self._spaces += 1
                time.sleep(self._repeat_s)

        thread = threading.Thread(target=repeat, name="space-repeater", daemon=True)
        thread.start()
        return thread

    @staticmethod
    def _quietly(fn) -> None:
        try:
            fn()
        except Exception:
            log.exception("cleanup step failed: %s", getattr(fn, "__qualname__", fn))
