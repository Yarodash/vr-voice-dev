"""Plays the headset's microphone audio into the virtual microphone.

The Steam Streaming Microphone driver copies bytes from its speaker side to its microphone side
without converting them and adds exactly +30 dB. Audio therefore has to be written in the
microphone's own format (WASAPI exclusive, 48 kHz, stereo, 32-bit) and attenuated by 30 dB.
"""
import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np

SAMPLE_RATE = 48000


def to_cable_frames(pcm_s16le_mono: bytes, gain_db: float) -> np.ndarray:
    count = len(pcm_s16le_mono) // 2
    mono = np.frombuffer(pcm_s16le_mono, dtype="<i2", count=count).astype(np.float32)
    mono *= np.float32(10 ** (gain_db / 20) / 32768.0)
    return np.column_stack([mono, mono])


class VirtualMicPlayer:
    def __init__(self, speaker_name: str, gain_db: float, sound=None):
        self._speaker_name = speaker_name
        self._gain_db = gain_db
        self._sound = sound  # the sounddevice module; replaceable in tests
        self._lock = threading.Lock()
        self._chunks: deque[np.ndarray] = deque()
        self._pending = 0
        self._stream = None
        # PortAudio has to be initialised and driven from one thread: a stream opened on another
        # thread fails with "Invalid device". Callers come from arbitrary threads, so everything
        # that touches the library is handed to this one.
        self._audio_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio-out")

    def open(self) -> None:
        self._audio_thread.submit(self._open).result()

    def close(self) -> None:
        self._audio_thread.submit(self._close).result()

    def _open(self) -> None:
        if self._sound is None:
            import sounddevice

            self._sound = sounddevice
        sd = self._sound
        try:
            self._stream = self._open_stream(sd)
        except sd.PortAudioError:
            # PortAudio lists the audio devices once, at start-up. When Windows re-enumerates
            # them later (a headset is plugged in, Steam restarts) that list goes stale and
            # opening fails with "Invalid device". Refresh the list and try once more.
            sd._terminate()
            sd._initialize()
            self._stream = self._open_stream(sd)
        self._stream.start()

    def _open_stream(self, sd):
        return sd.OutputStream(
            device=self._find_device(sd),
            samplerate=SAMPLE_RATE,
            channels=2,
            dtype="float32",
            callback=self._callback,
            extra_settings=sd.WasapiSettings(exclusive=True),
        )

    def feed(self, pcm: bytes) -> None:
        frames = to_cable_frames(pcm, self._gain_db)
        if len(frames):
            with self._lock:
                self._chunks.append(frames)
                self._pending += len(frames)

    def pending_seconds(self) -> float:
        with self._lock:
            return self._pending / SAMPLE_RATE

    def _close(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
            finally:
                stream.close()  # even if stopping failed: an open stream keeps the device busy
        with self._lock:
            self._chunks.clear()
            self._pending = 0

    def _find_device(self, sd) -> int:
        for index, dev in enumerate(sd.query_devices()):
            api = sd.query_hostapis(dev["hostapi"])["name"]
            if "WASAPI" in api and self._speaker_name in dev["name"] and dev["max_output_channels"] > 0:
                return index
        raise LookupError(f"playback device not found: {self._speaker_name!r}")

    def _callback(self, outdata, frames, time_info, status) -> None:
        filled = 0
        with self._lock:
            while filled < frames and self._chunks:
                chunk = self._chunks[0]
                take = min(len(chunk), frames - filled)
                outdata[filled:filled + take] = chunk[:take]
                if take == len(chunk):
                    self._chunks.popleft()
                else:
                    self._chunks[0] = chunk[take:]
                filled += take
            self._pending -= filled
        outdata[filled:] = 0
