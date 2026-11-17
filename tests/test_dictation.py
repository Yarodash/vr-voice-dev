import asyncio

import pytest

from bridge.dictation import Dictation

FRAME = b"\x00\x00" * 960  # 20 ms of 48 kHz mono


class Recorder:
    """Shared, ordered log of everything the dictation does to the outside world."""

    def __init__(self):
        self.events = []
        self.states = []

    def log(self, name):
        self.events.append(name)

    def count(self, name):
        return self.events.count(name)

    def index(self, name):
        return self.events.index(name)


class FakeDefaults:
    def __init__(self, rec):
        self.rec = rec

    def switch_to_virtual(self):
        self.rec.log("switch")

    def restore(self):
        self.rec.log("restore")


class FakePlayer:
    def __init__(self, rec, fail_open=False):
        self.rec = rec
        self.fail_open = fail_open
        self.fed = []
        self.pending = 0.0

    def open(self):
        if self.fail_open:
            raise RuntimeError("device busy")
        self.rec.log("open")

    def feed(self, pcm):
        self.fed.append(pcm)
        self.rec.log("feed")

    def pending_seconds(self):
        return self.pending

    def close(self):
        self.rec.log("close")


class FakeDetector:
    def __init__(self):
        self.armed = False

    def reset(self):
        self.armed = True

    def feed(self, text):
        return self.armed and "listening" in text


def make(rec, player=None, pty_write=None, **overrides):
    player = player or FakePlayer(rec)
    options = dict(repeat_s=0.005, listen_timeout_s=0.2, lead_in_s=0, tail_s=0.02, min_audio_s=0.04,
                   restore_delay_s=0.01, min_spaces=6, idle_audio_s=5, max_hold_s=30, drain_grace_s=1)
    options.update(overrides)
    dictation = Dictation(
        pty_write=pty_write or (lambda data: rec.log("space" if data == " " else f"write:{data!r}")),
        detector=FakeDetector(),
        defaults=FakeDefaults(rec),
        player=player,
        on_state=rec.states.append,
        **options,
    )
    return dictation, player


async def until(predicate, timeout=2.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        assert loop.time() < deadline, "condition not reached in time"
        await asyncio.sleep(0.002)


async def test_press_switches_mic_before_first_space():
    rec = Recorder()
    dictation, _ = make(rec)

    await dictation.press()
    await until(lambda: rec.count("space") >= 1)

    assert rec.index("switch") < rec.index("open") < rec.index("space")
    assert rec.states == ["warmup"]
    await dictation.release()
    await dictation.wait_idle()


async def test_audio_held_until_listening():
    rec = Recorder()
    dictation, player = make(rec)
    await dictation.press()
    await until(lambda: rec.count("space") >= 1)

    dictation.feed(b"a" * 1920)
    dictation.feed(b"b" * 1920)
    await asyncio.sleep(0.02)
    assert player.fed == []

    dictation.on_pty_output("\x1b[1mlistening…")
    await until(lambda: len(player.fed) == 2)
    dictation.feed(b"c" * 1920)

    assert player.fed == [b"a" * 1920, b"b" * 1920, b"c" * 1920]
    assert rec.states == ["warmup", "listening"]
    await dictation.release()
    await dictation.wait_idle()


async def test_listen_timeout_starts_playback():
    rec = Recorder()
    dictation, player = make(rec, listen_timeout_s=0.03)
    await dictation.press()
    dictation.feed(FRAME * 5)

    await until(lambda: len(player.fed) == 1)

    assert "listening" in rec.states
    await dictation.release()
    await dictation.wait_idle()


async def test_release_drains_then_stops_spaces_and_restores():
    rec = Recorder()
    dictation, player = make(rec)
    await dictation.press()
    dictation.on_pty_output("listening")
    dictation.feed(FRAME * 5)
    await until(lambda: len(player.fed) == 1)
    player.pending = 0.1

    await dictation.release()
    await asyncio.sleep(0.03)
    spaces_while_draining = rec.count("space")
    await asyncio.sleep(0.03)
    assert rec.count("space") > spaces_while_draining, "space must stay held while audio is still playing"
    assert "close" not in rec.events

    player.pending = 0.0
    await dictation.wait_idle()

    assert rec.index("close") < rec.index("restore")
    spaces_at_end = rec.count("space")
    await asyncio.sleep(0.03)
    assert rec.count("space") == spaces_at_end
    assert rec.states == ["warmup", "listening", "finalizing", "idle"]


async def test_tap_sends_minimum_burst_and_nothing_else():
    # A stray click: too short to be speech. Claude Code cleans up its own warm-up spaces once it
    # has seen ~6 repeats, so we always send that many and never type backspace or Esc ourselves.
    rec = Recorder()
    dictation, player = make(rec, repeat_s=0.002)
    await dictation.press()

    await dictation.release()
    await dictation.wait_idle()

    assert rec.count("space") >= 6
    assert not [e for e in rec.events if e.startswith("write:")]
    assert player.fed == []
    assert "restore" in rec.events
    assert rec.states[-1] == "idle"


async def test_restore_runs_when_player_open_fails():
    rec = Recorder()
    dictation, _ = make(rec, player=FakePlayer(rec, fail_open=True))

    await dictation.press()
    await dictation.wait_idle()

    assert "restore" in rec.events
    assert rec.count("space") == 0
    assert rec.states[-1] == "idle"


async def test_press_during_finalizing_waits_for_idle():
    rec = Recorder()
    dictation, player = make(rec, restore_delay_s=0.05)
    await dictation.press()
    dictation.on_pty_output("listening")
    dictation.feed(FRAME * 5)
    await until(lambda: len(player.fed) == 1)
    await dictation.release()
    await until(lambda: "finalizing" in rec.states)

    await dictation.press()

    assert rec.states.count("warmup") == 2
    assert rec.states.index("idle") < len(rec.states) - 1, "second dictation starts only after the first went idle"
    await until(lambda: rec.count("switch") == 2)
    await dictation.release()
    await dictation.wait_idle()


async def test_duplicate_press_is_ignored():
    rec = Recorder()
    dictation, _ = make(rec)
    await dictation.press()
    await until(lambda: rec.count("space") >= 1)

    await dictation.press()
    await asyncio.sleep(0.02)

    assert rec.count("switch") == 1
    await dictation.release()
    await dictation.wait_idle()


async def test_feed_while_idle_is_ignored():
    rec = Recorder()
    dictation, player = make(rec)

    dictation.feed(FRAME)

    assert player.fed == [] and rec.events == []


@pytest.mark.parametrize("call", ["release", "wait_idle"])
async def test_release_and_wait_idle_are_safe_when_idle(call):
    dictation, _ = make(Recorder())

    await getattr(dictation, call)()

    assert dictation.state == "idle"


async def test_hold_ends_by_itself_when_audio_stops():
    # The page froze or the headset went to sleep mid-sentence: frames stop, no "release" arrives.
    rec = Recorder()
    dictation, player = make(rec, idle_audio_s=0.05)
    await dictation.press()
    dictation.on_pty_output("listening")
    dictation.feed(FRAME * 5)
    await until(lambda: len(player.fed) == 1)

    await asyncio.wait_for(dictation.wait_idle(), 2)

    assert "restore" in rec.events
    assert rec.states[-1] == "idle"


async def test_hold_is_capped():
    rec = Recorder()
    dictation, player = make(rec, max_hold_s=0.08)
    await dictation.press()
    dictation.on_pty_output("listening")

    async def keep_talking():
        while dictation.state != "idle":
            dictation.feed(FRAME)
            await asyncio.sleep(0.005)

    await asyncio.wait_for(asyncio.gather(keep_talking(), dictation.wait_idle()), 2)

    assert "restore" in rec.events


async def test_audio_after_an_automatic_release_is_ignored():
    rec = Recorder()
    dictation, player = make(rec, idle_audio_s=0.03)
    await dictation.press()
    dictation.on_pty_output("listening")
    dictation.feed(FRAME * 5)
    await until(lambda: "finalizing" in rec.states)

    dictation.feed(b"late" * 480)

    assert b"late" * 480 not in player.fed
    await dictation.wait_idle()


async def test_tap_finishes_when_terminal_writes_fail():
    # Claude Code exited between the check and the write: the repeater dies on its first space.
    rec = Recorder()

    def closed_terminal(data):
        raise EOFError("terminal closed")

    dictation, _ = make(rec, pty_write=closed_terminal)
    await dictation.press()
    await dictation.release()

    await asyncio.wait_for(dictation.wait_idle(), 2)

    assert "restore" in rec.events
    assert rec.states[-1] == "idle"


async def test_drain_gives_up_when_player_stalls():
    rec = Recorder()
    dictation, player = make(rec, drain_grace_s=0.05)
    await dictation.press()
    dictation.on_pty_output("listening")
    dictation.feed(FRAME * 5)
    await until(lambda: len(player.fed) == 1)
    player.pending = 0.02  # the audio stream stopped pulling: this never reaches zero

    await dictation.release()
    await asyncio.wait_for(dictation.wait_idle(), 2)

    assert rec.index("close") < rec.index("restore")


async def test_failure_is_reported():
    rec = Recorder()
    errors = []
    dictation, _ = make(rec, player=FakePlayer(rec, fail_open=True), on_error=errors.append)

    await dictation.press()
    await dictation.wait_idle()

    assert len(errors) == 1 and "device busy" in errors[0]
