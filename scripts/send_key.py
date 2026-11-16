"""Presses one of the page's keys in the Claude Code terminal, for testing without the headset.

    .venv\\Scripts\\python scripts\\send_key.py clear        # also: enter esc up down pgup pgdn tab shift-tab
"""
import asyncio
import sys
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bridge.config import load_config  # noqa: E402


async def main(keys: list[str]) -> None:
    cfg = load_config(ROOT / "config.json")
    code = (ROOT / ".vr" / "pair-code").read_text(encoding="utf-8").strip()
    url = f"ws://127.0.0.1:{cfg.bridge_port}/bridge?code={code}"
    async with aiohttp.ClientSession() as session, session.ws_connect(url) as ws:
        await asyncio.sleep(1.0)
        for key in keys:
            if key.startswith("send:"):  # send:<text> acts like pressing "send" with that draft
                await ws.send_json({"t": "send", "text": key[5:]})
            else:
                await ws.send_json({"t": "key", "k": key})
            await asyncio.sleep(0.4)
        await asyncio.sleep(0.6)
    print("sent:", " ".join(keys))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
