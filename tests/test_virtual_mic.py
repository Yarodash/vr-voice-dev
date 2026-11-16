import time

import numpy as np
import pytest

from bridge.virtual_mic import VirtualMicPlayer, to_cable_frames

SPEAKER = "Speakers (Steam Streaming Microphone)"
MIC = "Microphone (Steam Streaming Microphone)"


def test_to_cable_frames_scales_minus_30db():
    pcm = np.array([16384, -16384, 0], dtype="<i2").tobytes()

    frames = to_cable_frames(pcm, -30)

    assert frames.shape == (3, 2)
    assert frames.dtype == np.float32
    expected = 0.5 * 10 ** (-30 / 20)
    np.testing.assert_allclose(frames[0], [expected, expected], rtol=1e-5)
    np.testing.assert_allclose(frames[1], [-expected, -expected], rtol=1e-5)
    np.testing.assert_allclose(frames[2], [0, 0])


def test_to_cable_frames_ignores_trailing_odd_byte():
    pcm = np.array([1000, 2000], dtype="<i2").tobytes() + b"\x01"

    assert to_cable_frames(pcm, 0).shape == (2, 2)


@pytest.mark.integration
def test_tone_arrives_clean():
    import importlib

    from bridge.audio_devices import PycawBackend

    backend = PycawBackend()
    backend.unmute(backend.find_capture_id(MIC))
    player = VirtualMicPlayer(SPEAKER, gain_db=-30)
    # The audio library must live on the player's thread, so the recording side of this test
    # is set up there as well (the bridge itself never touches the library elsewhere).
    on_audio_thread = lambda fn, *args: player._audio_thread.submit(fn, *args).result()  # noqa: E731
    sd = on_audio_thread(importlib.import_module, "sounddevice")
    capture = next(
        i for i, d in enumerate(sd.query_devices())
        if "WASAPI" in sd.query_hostapis(d["hostapi"])["name"] and MIC in d["name"] and d["max_input_channels"] > 0
    )
    sr, amp = 48000, 0.2
    t = np.arange(sr) / sr
    tone = (amp * np.sin(2 * np.pi * 440 * t) * 32767).astype("<i2")
    recorded = []

    def start_recording():
        stream = sd.InputStream(device=capture, samplerate=sr, channels=1, dtype="float32",
                                callback=lambda indata, frames, tm, status: recorded.append(indata.copy()))
        stream.start()
        return stream

    def stop_recording(stream):
        stream.stop()
        stream.close()

    recorder = on_audio_thread(start_recording)
    try:
        # Same shape as real use: Dictation holds the first ~0.3 s back until Claude Code is
        # listening, so the player always starts with a backlog; the rest arrives in real time.
        chunks = [tone[start:start + 960].tobytes() for start in range(0, len(tone), 960)]
        for chunk in chunks[:10]:
            player.feed(chunk)
        player.open()
        try:
            started = time.perf_counter()
            for n, chunk in enumerate(chunks[10:], start=1):
                player.feed(chunk)
                time.sleep(max(0.0, started + n * 0.02 - time.perf_counter()))
            while player.pending_seconds() > 0:
                time.sleep(0.01)
            time.sleep(0.3)
        finally:
            player.close()
    finally:
        on_audio_thread(stop_recording, recorder)

    data = np.concatenate(recorded)[:, 0]
    active = data[np.abs(data) > amp * 0.05]
    assert len(active) > sr * 0.8, "most of the one-second tone should come through"
    loud = np.flatnonzero(np.abs(data) > amp * 0.05)
    seg = data[loud[0] + 2400: loud[-1] - 2400]
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    peak = freqs[np.abs(np.fft.rfft(seg * np.hanning(len(seg)))).argmax()]
    assert abs(peak - 440) < 3
    assert 0.9 < np.abs(seg).max() / amp < 1.1
    assert np.mean(seg == 0) < 0.01


class FakeSoundDevice:
    """Stands in for the sounddevice module: its device list goes stale until it is re-initialised."""

    class PortAudioError(Exception):
        pass

    class WasapiSettings:
        def __init__(self, exclusive=False):
            self.exclusive = exclusive

    class _Stream:
        def start(self):
            pass

        def stop(self):
            pass

        def close(self):
            pass

    def __init__(self, stale=True, broken=False):
        self.stale, self.broken, self.reinitialised = stale, broken, 0

    def query_devices(self):
        return [{"name": SPEAKER, "hostapi": 0, "max_output_channels": 2}]

    def query_hostapis(self, index):
        return {"name": "Windows WASAPI"}

    def OutputStream(self, **kwargs):  # noqa: N802 - mirrors the real module
        if self.stale or self.broken:
            raise self.PortAudioError("Error opening OutputStream: Invalid device [PaErrorCode -9996]")
        return self._Stream()

    def _terminate(self):
        pass

    def _initialize(self):
        self.reinitialised += 1
        self.stale = False


def test_open_refreshes_a_stale_device_list_and_tries_again():
    # Windows re-enumerated its audio devices after the bridge started (a headset was plugged in,
    # Steam restarted): the cached list no longer matches and the first attempt fails.
    sound = FakeSoundDevice(stale=True)
    player = VirtualMicPlayer(SPEAKER, gain_db=-30, sound=sound)

    player.open()

    assert sound.reinitialised == 1
    player.close()


def test_open_gives_up_after_one_refresh():
    sound = FakeSoundDevice(broken=True)
    player = VirtualMicPlayer(SPEAKER, gain_db=-30, sound=sound)

    with pytest.raises(FakeSoundDevice.PortAudioError):
        player.open()

    assert sound.reinitialised == 1


def test_the_audio_library_is_always_used_from_the_same_thread():
    # PortAudio (WASAPI) refuses a stream opened on a different thread than the one that
    # initialised it ("Invalid device"), and callers reach open()/close() from arbitrary threads.
    import threading

    used_from = []

    class Recording(FakeSoundDevice):
        def OutputStream(self, **kwargs):  # noqa: N802
            used_from.append(threading.get_ident())
            return super().OutputStream(**kwargs)

    player = VirtualMicPlayer(SPEAKER, gain_db=-30, sound=Recording(stale=False))

    def use():
        player.open()
        player.close()

    for _ in range(3):
        caller = threading.Thread(target=use)
        caller.start()
        caller.join()

    assert len(used_from) == 3 and len(set(used_from)) == 1
