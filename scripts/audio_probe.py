"""Diagnostic: under which conditions can the virtual speaker be opened? Each case runs in its
own process. Stop the bridge first: it may be holding the device."""
import subprocess
import sys

OPEN = """
def open_speaker():
    import sounddevice as sd
    name = 'Speakers (Steam Streaming Microphone)'
    dev = next(i for i, d in enumerate(sd.query_devices())
               if 'WASAPI' in sd.query_hostapis(d['hostapi'])['name'] and name in d['name'] and d['max_output_channels'] > 0)
    try:
        s = sd.OutputStream(device=dev, samplerate=48000, channels=2, dtype='float32',
                            extra_settings=sd.WasapiSettings(exclusive=True))
        s.close()
        print('ok', flush=True)
    except Exception as e:
        print('FAIL', str(e)[-45:], flush=True)
"""
BACKEND = """
from pathlib import Path
from bridge.audio_devices import CaptureDefaults, PycawBackend
defaults = CaptureDefaults(PycawBackend(), 'Microphone (Steam Streaming Microphone)', Path('.vr/probe-mic.json'))
defaults.prepare()
"""
IN_THREAD = """
import threading
t = threading.Thread(target=open_speaker); t.start(); t.join()
"""
EXIT = "\nimport os\nos._exit(0)\n"

CASES = {
    "main thread, sounddevice only": OPEN + "open_speaker()\n",
    "worker thread, sounddevice only": OPEN + IN_THREAD,
    "main thread, after pycaw prepare": OPEN + BACKEND + "open_speaker()\n",
    "worker thread, after pycaw prepare": OPEN + BACKEND + IN_THREAD,
    "main thread, after switching default mic": OPEN + BACKEND + "defaults.switch_to_virtual()\nopen_speaker()\ndefaults.restore()\n",
    "worker thread, after switching default mic": OPEN + BACKEND + "defaults.switch_to_virtual()\n" + IN_THREAD + "defaults.restore()\n",
    "import sounddevice in one thread, open in another": OPEN + (
        "import threading\n"
        "def load():\n    import sounddevice\n"
        "t = threading.Thread(target=load); t.start(); t.join()\n" + IN_THREAD
    ),
}

for label, code in CASES.items():
    result = subprocess.run([sys.executable, "-c", code + EXIT], capture_output=True, text=True, cwd=".")
    last = (result.stdout.strip().splitlines() or ["(no output) " + result.stderr.strip()[-90:]])[-1]
    print(f"{label:52} -> {last}")
