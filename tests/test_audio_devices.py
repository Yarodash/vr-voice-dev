import json

from bridge.audio_devices import ROLES, CaptureDefaults

MIC = "Microphone (Steam Streaming Microphone)"


class FakeBackend:
    def __init__(self):
        self.defaults = {"console": "realtek", "multimedia": "realtek", "communications": "headset"}
        self.unmuted = []
        self.calls = []

    def find_capture_id(self, name):
        assert name == MIC
        return "virtual"

    def unmute(self, dev_id):
        self.unmuted.append(dev_id)

    def get_default(self, role):
        return self.defaults[role]

    def set_default(self, dev_id, role):
        self.calls.append((dev_id, role))
        self.defaults[role] = dev_id


def make(tmp_path):
    backend = FakeBackend()
    return backend, CaptureDefaults(backend, MIC, tmp_path / "default-mic.json")


def test_prepare_unmutes_virtual_mic(tmp_path):
    backend, defaults = make(tmp_path)

    defaults.prepare()

    assert backend.unmuted == ["virtual"]


def test_switch_saves_and_sets_all_roles(tmp_path):
    backend, defaults = make(tmp_path)
    defaults.prepare()

    defaults.switch_to_virtual()

    assert backend.defaults == {role: "virtual" for role in ROLES}
    saved = json.loads((tmp_path / "default-mic.json").read_text())
    assert saved == {"console": "realtek", "multimedia": "realtek", "communications": "headset"}


def test_restore_returns_originals_and_removes_state(tmp_path):
    backend, defaults = make(tmp_path)
    defaults.prepare()
    defaults.switch_to_virtual()

    defaults.restore()

    assert backend.defaults == {"console": "realtek", "multimedia": "realtek", "communications": "headset"}
    assert not (tmp_path / "default-mic.json").exists()


def test_prepare_recovers_after_crash(tmp_path):
    # A previous run died while the virtual mic was the default: the state file is still there.
    backend, defaults = make(tmp_path)
    backend.defaults = {role: "virtual" for role in ROLES}
    (tmp_path / "default-mic.json").write_text(
        json.dumps({"console": "realtek", "multimedia": "realtek", "communications": "headset"})
    )

    defaults.prepare()

    assert backend.defaults == {"console": "realtek", "multimedia": "realtek", "communications": "headset"}
    assert not (tmp_path / "default-mic.json").exists()


def test_restore_without_switch_is_noop(tmp_path):
    backend, defaults = make(tmp_path)
    defaults.prepare()

    defaults.restore()

    assert backend.calls == []


def test_second_switch_keeps_the_real_originals(tmp_path):
    # Switching twice without a restore must not overwrite the saved originals with "virtual".
    backend, defaults = make(tmp_path)
    defaults.prepare()
    defaults.switch_to_virtual()

    defaults.switch_to_virtual()
    defaults.restore()

    assert backend.defaults == {"console": "realtek", "multimedia": "realtek", "communications": "headset"}


def test_prepare_survives_a_truncated_state_file(tmp_path):
    # The bridge was killed while writing the file: it must still start next time.
    backend, defaults = make(tmp_path)
    (tmp_path / "default-mic.json").write_text('{"console": "rea')

    defaults.prepare()

    assert backend.calls == []
    assert not (tmp_path / "default-mic.json").exists()
