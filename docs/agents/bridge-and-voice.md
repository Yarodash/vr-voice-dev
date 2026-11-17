# Bridge and voice pipeline

Files: `bridge/` (Python, aiohttp; run by `npm start` as `.venv\Scripts\python -m bridge`),
`scripts/vr-eval.mjs`, `scripts/vr-say.mjs`, `scripts/scene-check.mjs`, `scripts/e2e_voice.py`,
shell `web/src/bridge-client.js`, `remote-console.js`, `screenshot.js`, `mic.js`, `draft.js`.
`config.json`: `lan_host`, `web_port 5173`, `bridge_port 8765`, terminal size, audio devices,
hidden Claude model. Changing `bridge/` needs a bridge restart (ask the user/dispatcher).

## Voice path

Headset holds Y -> page streams 48 kHz s16 PCM over `/bridge` WS -> bridge holds Space in a
**hidden Claude Code** running in a pseudo-terminal (`claude_pty.py`, voice mode `hold`,
`autoSubmit: false`) and plays the audio into the virtual mic (Steam Streaming Microphone,
`virtual_mic.py`, `audio_devices.py` switches the default device only while dictating) ->
Claude Code's own dictation types into its prompt -> the page reads the prompt box from the
terminal stream (`draft.js`) -> on send the bridge queues the text for `/inbox` (phrases ending
in «отмена» are dropped). The hidden Claude never executes anything.

Timing details (`dictation.py`, `__main__.py`, `screen.py`):
- `listening…` is detected on the **rendered** screen (pyte, `bridge/screen.py`), not the raw
  stream: Claude Code repaints only changed cells, so the raw output carries e.g. "listning…".
  Audio is held back until then (timeout 4 s), with 0.3 s of silence in front of the first words.
- After every (re)start of the hidden Claude the bridge runs one silent priming dictation
  (invisible to the page), then clears the prompt; a Y press during it simply takes it over.
- The page treats the draft as final only when the voice state is idle, the screen no longer
  shows `Transcribing…` and the text has not changed for 0.5 s (`isTranscribing` in `draft.js`).

Config phrases: if the first word is «конфиг»/«конфик»/«config»/«конфигурация», the phrase skips
`/inbox` (the main session never sees it; it is logged in `vr-inbox.log` as `[config agent] …`).
`bridge/config_agent.py` runs a headless `claude -p --model haiku` in the project root, one phrase
at a time (120 s timeout), prompt = `docs/agents/config.md` + the phrase; tools limited to
Read/Edit/Grep/Glob + `npm run scene:check` / `npm run vr:eval`. The headset gets «⚙ меняю…» at
once, then «⚙ <its answer>» (or «⚙ ошибка: …») as a say message. Start/finish/duration go to the bridge log.

## Endpoints (`bridge/server.py`)

| Endpoint | Who | What |
|---|---|---|
| WS `/bridge?code=` | the page (via Vite proxy) | ptt, audio, scene status, console lines, eval results; bridge sends terminal bytes, voice state, eval requests, say messages |
| WS `/inbox?code=` | the PC Claude session (Monitor, `timeout_ms 1800000`) | one text frame per sent phrase; queued while nobody listens |
| POST `/say` | `node scripts/vr-say.mjs "text"` | pop-up in the headset (unread until closed) |
| POST `/eval` | `npm run vr:eval` | runs JS on every connected page; `X-Pair-Code` header |

Pairing code: `.vr/pair-code`. Pages are labelled `quest` (Oculus/Quest UA) or `desktop`.

## Files the bridge writes

- `logs/scene-status.json` — `{ ok, error, at }` from the page; `scene:check` waits until `at` is
  newer than the newest scene file mtime, then 0.5 s more to catch first-frame errors.
- `logs/page-console.log` — every `console.*` and uncaught error of every page, prefixed
  `HH:MM:SS [quest] LOG|WARN|ERROR`; trimmed to the newest half past 1 MB.
- `logs/screenshots/*.jpg` — from `screenshot()`.
- `logs/vr-inbox.log`.

## vr:eval scope

`THREE, scene, root, camera, renderer, session, ctx, sceneHost, sceneInstance, panel, mic,
controls, screenshot, draft, recording, messages, rig, recenter, wheel, menu`. Scene handles via
`__sceneState.*`. Single expressions are returned; multi-statement code needs `return`. Results
are formatted to depth 3 / 4000 chars. Exit 0 value, 1 error, 2 no page.

`screenshot({ eyes: 'both'|'left'|'right', width = 1024 })` renders the scene again from each eye
into an off-screen target (linear -> sRGB conversion on CPU) after the frame; in 2D it captures
the normal view; if the headset is off and no frames are drawn, there is no answer (use
`--timeout`).

## Rules

- Never run `scripts/e2e_voice.py` while the user is in VR (it types into the same hidden prompt).
- Only the session that talks to the user calls `vr-say`; subagents report to their caller.
- Voice events are user requests; a phrase ending in «скажи ок» cancels it (reply «Ок.» only).
