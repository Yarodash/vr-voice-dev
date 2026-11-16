"""Fake headset: "holds the trigger", speaks a phrase into the bridge and checks what the
Claude Code terminal shows afterwards. Needs `npm start` running.

    .venv\\Scripts\\python scripts\\e2e_voice.py                      # through Vite, like the real page
    .venv\\Scripts\\python scripts\\e2e_voice.py --direct             # straight to the bridge
    .venv\\Scripts\\python scripts\\e2e_voice.py --say "Сделай куб зелёным" --expect "зел"
"""
import argparse
import asyncio
import os
import re
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bridge.claude_pty import strip_ansi  # noqa: E402
from bridge.config import load_config  # noqa: E402

CHUNK = 960 * 2  # 20 ms of 48 kHz 16-bit mono

TTS = r"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ru = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
if ($ru) { $s.SelectVoice($ru.VoiceInfo.Name) }
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($env:E2E_WAV, $fmt)
$s.Speak($env:E2E_TEXT)
$s.Dispose()
"""


def synthesize(text: str) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "phrase.wav"
        env = {**os.environ, "E2E_WAV": str(wav), "E2E_TEXT": text}
        subprocess.run(["powershell.exe", "-NoProfile", "-Command", TTS], check=True, env=env)
        with wave.open(str(wav), "rb") as w:
            assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (48000, 1, 2)
            pcm = w.readframes(w.getnframes())
    silence = b"\x00\x00" * 48000
    return silence[: 9600 * 2] + pcm + silence[: 14400 * 2]


async def run(args) -> int:
    cfg = load_config(ROOT / "config.json")
    code = (ROOT / ".vr" / "pair-code").read_text(encoding="utf-8").strip()
    url = (f"ws://127.0.0.1:{cfg.bridge_port}/bridge?code={code}" if args.direct
           else f"wss://{cfg.lan_host}:{cfg.web_port}/bridge?code={code}")
    pcm = synthesize(args.say)
    seen: list[str] = []

    async with aiohttp.ClientSession() as session, session.ws_connect(url, ssl=False) as ws:
        async def reader():
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    seen.append(msg.data.decode("utf-8", "replace"))

        task = asyncio.create_task(reader())
        await asyncio.sleep(1.5)  # let the replay and the redraw arrive
        mark = len(seen)

        await ws.send_json({"t": "ptt", "down": True})
        started = time.perf_counter()
        for n, start in enumerate(range(0, len(pcm), CHUNK), start=1):
            await ws.send_bytes(pcm[start:start + CHUNK])
            await asyncio.sleep(max(0.0, started + n * 0.02 - time.perf_counter()))
        await ws.send_json({"t": "ptt", "down": False})

        deadline = time.monotonic() + args.timeout
        pattern = re.compile(args.expect)
        text = ""
        while time.monotonic() < deadline:
            text = strip_ansi("".join(seen[mark:]))
            if pattern.search(text):
                print("E2E OK")
                task.cancel()
                return 0
            await asyncio.sleep(0.25)
        task.cancel()
        print("E2E FAILED: pattern not found. Terminal output after the phrase:\n" + text[-1500:])
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--say", default="Ответь одним словом: привет.")
    parser.add_argument("--expect", default=r"●\s*[Пп]ривет", help="regex that must appear in the terminal")
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--direct", action="store_true", help="connect to the bridge, bypassing Vite")
    sys.exit(asyncio.run(run(parser.parse_args())))
