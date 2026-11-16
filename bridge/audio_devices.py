"""Windows default-microphone control.

Claude Code's built-in dictation records from the *default* recording device and opens it when a
recording starts. We make the virtual mic the default only while dictating and always put the
user's own devices back, including after a crash (the originals are kept in a state file).
"""
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Protocol

log = logging.getLogger(__name__)

ROLES = ("console", "multimedia", "communications")


class AudioBackend(Protocol):
    def find_capture_id(self, name: str) -> str: ...
    def unmute(self, dev_id: str) -> None: ...
    def get_default(self, role: str) -> str: ...
    def set_default(self, dev_id: str, role: str) -> None: ...


class CaptureDefaults:
    def __init__(self, backend: AudioBackend, mic_name: str, state_file: Path):
        self._backend = backend
        self._mic_name = mic_name
        self._state_file = Path(state_file)
        self._mic_id: str | None = None

    def prepare(self) -> None:
        # Restore first: it must happen even if the virtual mic has disappeared since last time.
        if self._state_file.exists():
            log.warning("previous run left the virtual mic as default; restoring the original devices")
            self._apply_saved()
        self._mic_id = self._backend.find_capture_id(self._mic_name)
        self._backend.unmute(self._mic_id)

    def switch_to_virtual(self) -> None:
        if self._mic_id is None:
            self.prepare()
        if not self._state_file.exists():
            saved = {role: self._backend.get_default(role) for role in ROLES}
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            self._state_file.write_text(json.dumps(saved), encoding="utf-8")
        for role in ROLES:
            self._backend.set_default(self._mic_id, role)

    def restore(self) -> None:
        if self._state_file.exists():
            self._apply_saved()

    def _apply_saved(self) -> None:
        try:
            saved = json.loads(self._state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # Killed in the middle of writing it: nothing usable to restore, but we must still start.
            log.warning("unreadable %s; cannot restore the previous default microphone", self._state_file)
            saved = {}
        for role in ROLES:
            if role in saved:
                try:
                    self._backend.set_default(saved[role], role)
                except Exception:  # a saved device may have been unplugged meanwhile
                    log.exception("could not restore default recording device for role %s", role)
        self._state_file.unlink()


class PycawBackend:
    """Core Audio through pycaw. All COM calls run on one dedicated thread."""

    def __init__(self):
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio-com", initializer=self._init_com)

    @staticmethod
    def _init_com():
        import comtypes

        comtypes.CoInitialize()

    def _run(self, fn, *args):
        return self._pool.submit(fn, *args).result()

    def find_capture_id(self, name: str) -> str:
        return self._run(self._find_capture_id, name)

    def unmute(self, dev_id: str) -> None:
        self._run(self._unmute, dev_id)

    def get_default(self, role: str) -> str:
        return self._run(self._get_default, role)

    def set_default(self, dev_id: str, role: str) -> None:
        self._run(self._set_default, dev_id, role)

    @staticmethod
    def _erole(role: str):
        from pycaw.constants import ERole

        return {"console": ERole.eConsole, "multimedia": ERole.eMultimedia, "communications": ERole.eCommunications}[role]

    @staticmethod
    def _find_capture_id(name: str) -> str:
        from pycaw.constants import DEVICE_STATE, EDataFlow
        from pycaw.pycaw import AudioUtilities

        endpoints = AudioUtilities.GetDeviceEnumerator().EnumAudioEndpoints(
            EDataFlow.eCapture.value, DEVICE_STATE.ACTIVE.value
        )
        for n in range(endpoints.GetCount()):
            dev = endpoints.Item(n)
            if AudioUtilities.CreateDevice(dev).FriendlyName == name:
                return dev.GetId()
        raise LookupError(f"recording device not found: {name!r}")

    @staticmethod
    def _unmute(dev_id: str) -> None:
        from ctypes import POINTER, cast

        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume

        dev = AudioUtilities.GetDeviceEnumerator().GetDevice(dev_id)
        volume = cast(dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None), POINTER(IAudioEndpointVolume))
        volume.SetMute(0, None)

    def _get_default(self, role: str) -> str:
        from pycaw.constants import EDataFlow
        from pycaw.pycaw import AudioUtilities

        return (
            AudioUtilities.GetDeviceEnumerator()
            .GetDefaultAudioEndpoint(EDataFlow.eCapture.value, self._erole(role).value)
            .GetId()
        )

    def _set_default(self, dev_id: str, role: str) -> None:
        from pycaw.pycaw import AudioUtilities

        AudioUtilities.SetDefaultDevice(dev_id, roles=[self._erole(role)])
