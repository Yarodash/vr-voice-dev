"""Typed view of config.json (the same file vite.config.js reads)."""
import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TerminalConfig:
    cols: int
    rows: int


@dataclass(frozen=True)
class AudioConfig:
    virtual_speaker: str
    virtual_mic: str
    cable_gain_db: float
    mic_gain_db: float


@dataclass(frozen=True)
class ClaudeConfig:
    model: str  # "" = the user's default model
    effort: str  # "" = the user's default effort
    extra_args: list[str]
    # Session id of an existing conversation. When set, the VR terminal starts as a copy of that
    # conversation (same history and context) instead of an empty one.
    fork_from: str = ""


@dataclass(frozen=True)
class Config:
    lan_host: str
    web_port: int
    bridge_port: int
    terminal: TerminalConfig
    audio: AudioConfig
    claude: ClaudeConfig


def load_config(path: Path) -> Config:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return Config(
        lan_host=raw["lan_host"],
        web_port=raw["web_port"],
        bridge_port=raw["bridge_port"],
        terminal=TerminalConfig(**raw["terminal"]),
        audio=AudioConfig(**raw["audio"]),
        claude=ClaudeConfig(**raw["claude"]),
    )
