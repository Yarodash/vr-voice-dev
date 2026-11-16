"""Voice phrases that start with «конфиг»: a quick headless Haiku Claude Code changes a game setting.

The phrase never reaches the main Claude session; the agent's last sentence goes to the headset.
"""
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from bridge.claude_pty import child_env

log = logging.getLogger(__name__)

CONFIG_WORDS = {"конфиг", "конфик", "config", "конфигурация"}
TIMEOUT_S = 120.0
TOOLS = "Read,Edit,Grep,Glob,Bash,PowerShell"
ALLOWED = [
    "Read", "Edit", "Grep", "Glob",
    "Bash(npm run scene:check)", "Bash(npm run vr:eval *)",
    "PowerShell(npm run scene:check)", "PowerShell(npm run vr:eval *)",
]
TASK = (
    "Make the change, run `npm run scene:check`, then answer in one short Russian sentence what you "
    "changed (that sentence is shown to the user in the headset). Your final message must be only "
    "that sentence."
)
_FIRST_WORD = re.compile(r"[\W_]*([^\W_]+)")


def is_config_phrase(text: str) -> bool:
    match = _FIRST_WORD.match(text or "")
    return bool(match) and match.group(1).lower().replace("ё", "е") in CONFIG_WORDS


def build_argv(claude: str) -> list[str]:
    # The prompt goes through stdin; --allowedTools takes the rest of the line, so it stays last.
    return [claude, "-p", "--model", "haiku", "--output-format", "json",
            "--permission-mode", "acceptEdits", "--permission-prompts", "none",
            "--tools", TOOLS, "--strict-mcp-config", "--no-session-persistence",
            "--allowedTools", *ALLOWED]


class ConfigAgent:
    def __init__(self, root: Path, guide: Path | None = None, timeout: float = TIMEOUT_S):
        self._root = Path(root)
        self._guide = Path(guide) if guide else self._root / "docs" / "agents" / "config.md"
        self._timeout = timeout

    def prompt(self, phrase: str) -> str:
        return f"{self._guide.read_text(encoding='utf-8')}\n\nUser phrase: {phrase}\n\n{TASK}\n"

    async def run(self, phrase: str) -> str:
        """Returns the agent's answer; raises RuntimeError with a short Russian reason on failure."""
        claude = shutil.which("claude")
        if claude is None:
            raise RuntimeError("не найден claude")
        started = time.monotonic()
        log.info("config agent: start %r", phrase)
        proc = await asyncio.create_subprocess_exec(
            *build_argv(claude), cwd=str(self._root), env=child_env(os.environ),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(self.prompt(phrase).encode("utf-8")),
                                              self._timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError) as stop:
            _kill_tree(proc.pid)
            await proc.wait()
            log.warning("config agent: stopped after %.1f s", time.monotonic() - started)
            if isinstance(stop, asyncio.CancelledError):
                raise
            raise RuntimeError(f"не успел за {self._timeout:g} с") from None
        took = time.monotonic() - started
        answer, failed = _parse(out.decode("utf-8", "replace"))
        if proc.returncode != 0 or failed or not answer:
            log.warning("config agent: failed in %.1f s (exit %s): %s %s", took, proc.returncode,
                        answer[:300], err.decode("utf-8", "replace")[-300:])
            raise RuntimeError(f"не получилось ({answer[:120] or f'код {proc.returncode}'})")
        log.info("config agent: done in %.1f s: %s", took, answer)
        return answer


def _parse(stdout: str) -> tuple[str, bool]:
    """(answer, is_error) from `--output-format json`; plain text if it is not JSON."""
    for line in reversed(stdout.strip().splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("type") == "result":
            return str(data.get("result") or "").strip(), bool(data.get("is_error"))
    return stdout.strip(), False


def _kill_tree(pid: int) -> None:
    # npm and node started by the agent would outlive a plain kill of claude.exe.
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
