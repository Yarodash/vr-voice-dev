from pathlib import Path

from bridge.config import load_config

ROOT = Path(__file__).resolve().parent.parent


def test_load_config_reads_all_sections():
    cfg = load_config(ROOT / "config.json")

    assert cfg.lan_host == "192.168.0.10"
    assert cfg.web_port == 5173
    assert cfg.bridge_port == 8765
    assert (cfg.terminal.cols, cfg.terminal.rows) == (84, 24)
    assert cfg.audio.virtual_speaker == "Speakers (Steam Streaming Microphone)"
    assert cfg.audio.virtual_mic == "Microphone (Steam Streaming Microphone)"
    assert cfg.audio.cable_gain_db == -30
    assert cfg.audio.mic_gain_db == 0
    assert cfg.claude.model == "haiku"
    assert cfg.claude.effort == ""
    assert cfg.claude.extra_args == []
    assert cfg.claude.fork_from == ""


def test_fork_from_is_optional(tmp_path):
    import json

    raw = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    raw["claude"].pop("fork_from", None)
    path = tmp_path / "config.json"
    path.write_text(json.dumps(raw), encoding="utf-8")

    assert load_config(path).claude.fork_from == ""
