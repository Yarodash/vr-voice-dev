# VR Voice Dev — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница для Quest 3S, в которой одной левой рукой можно голосом давать задания Claude Code и видеть, как сцена меняется без перезагрузки и выхода из VR.

**Architecture:** Два процесса на ПК. Vite раздаёт страницу по HTTPS и подменяет модуль сцены через HMR; Python-мост держит настоящий `claude` в псевдотерминале, подаёт звук с Quest в виртуальный микрофон и «зажимает пробел», чтобы работала встроенная диктовка. Страница общается с мостом по одному WebSocket (`/bridge`, проксируется через Vite).

**Tech Stack:** Python 3.12 (aiohttp, pywinpty, sounddevice, numpy, pycaw, cryptography, pytest) · Node 24 (Vite 8, three r187, @xterm/xterm, @fontsource/jetbrains-mono, concurrently, vitest).

**Spec:** `docs/superpowers/specs/2026-11-16-vr-voice-dev-design.md`

## Global Constraints

- Свой venv: `py -3.12 -m venv .venv`. Команду `python` из PATH не использовать (это чужое окружение hermes).
- Виртуальный микрофон: играть в `Speakers (Steam Streaming Microphone)` только WASAPI exclusive, 48000 Гц, 2 канала, float32, с усилением `cable_gain_db = -30`. Запись идёт с `Microphone (Steam Streaming Microphone)`; при старте снять с него «без звука».
- Микрофон по умолчанию (все три роли: console, multimedia, communications) переключается только на время диктовки и всегда возвращается.
- Удержание пробела: писать `" "` в псевдотерминал каждые 33 мс. Признак начала записи — слово `listening` в выводе терминала.
- VR-сессия Claude: `--session-id <uuid>` при первом запуске, `--resume <uuid>` дальше. `--continue` не использовать (подхватит чужой разговор из этой же папки). Настройки сессии — файлом: `--settings .vr/claude-settings.json` = `{"voice":{"enabled":true,"mode":"hold","autoSubmit":true}}`. Из окружения дочернего процесса убрать `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_*`.
- Сеть: Vite слушает только `lan_host` (192.168.0.10:5173, strictPort) — не `0.0.0.0`, на машине есть Radmin VPN и Tailscale. Мост слушает только 127.0.0.1:8765.
- Сертификат создаётся один раз и не пересоздаётся (исключение в браузере Quest привязано к отпечатку).
- Контракт сцены: `export function setup(ctx)` → `{ update(dt), dispose() }`; объекты сцена добавляет в `ctx.root`.
- Левый контроллер: источник ввода с `handedness === 'left' && gamepad && !hand`; кнопки 0 курок, 1 grip, 3 нажатие стика, 4 X, 5 Y; ось 3 — стик по вертикали.
- Git в проекте нет; коммиты не делать, пока пользователь не попросит.
- Перед использованием каждой библиотеки сверяться с её актуальной документацией (правило пользователя).

## Review Focus

1. Мост упал, пока микрофон по умолчанию был переключён → при следующем старте исходный микрофон восстановлен (Task 2).
2. Короткое нажатие курка / отпускание до `listening` → в строке ввода не остаётся пробелов, запись не зависает (Task 4).
3. Новый код сцены падает в `setup` или в `update` → остаётся предыдущая сцена, цикл отрисовки жив, ошибка дошла до `logs/scene-status.json` (Task 6).
4. Страница отвалилась (перезагрузка, сон шлема, отключился контроллер) посреди удержания → диктовка завершается сама, микрофон возвращён (Task 5, Task 8).
5. Чужое устройство в сети открывает страницу → без кода сопряжения WebSocket не открывается; с кодом в терминал можно послать только клавиши из белого списка (Task 5).

---

## File Structure

```
config.json  package.json  vite.config.js  requirements.txt  CLAUDE.md  README.md
bridge/   __main__.py  config.py  cert.py  audio_devices.py  virtual_mic.py
          claude_pty.py  dictation.py  server.py
tests/    test_*.py  fixtures/pty_hold.txt
scripts/  e2e_voice.py  scene-check.mjs
web/      index.html
web/src/  main.js  scene-host.js  bridge-client.js  terminal-panel.js  term-paint.js
          mic.js  pcm-worklet.js  pcm.js  controls.js  control-mapper.js  scene/main.js
web/tests/  *.test.js
.vr/ (состояние: session.json, default-mic.json, claude-settings.json, pair-code)  certs/  logs/
```

---

### Task 1: Каркас, конфиг, HTTPS

**Files:** Create `config.json`, `package.json`, `vite.config.js`, `requirements.txt`, `bridge/__init__.py`, `bridge/config.py`, `bridge/cert.py`, `web/index.html`, `web/src/main.js` (заглушка), `tests/test_config.py`, `tests/test_cert.py`

**Interfaces — Produces:**
- `config.json`: `{"lan_host":"192.168.0.10","web_port":5173,"bridge_port":8765,"terminal":{"cols":100,"rows":32},"audio":{"virtual_speaker":"Speakers (Steam Streaming Microphone)","virtual_mic":"Microphone (Steam Streaming Microphone)","cable_gain_db":-30,"mic_gain_db":0},"claude":{"model":"sonnet","effort":"low","extra_args":[]}}`
- `bridge.config.load_config(path: Path) -> Config` (вложенные dataclass'ы с теми же именами полей).
- `bridge.cert.ensure_cert(cert_dir: Path, hosts: list[str]) -> tuple[Path, Path]` — `certs/dev.pem`, `certs/dev-key.pem`; SAN = hosts + `localhost` + `127.0.0.1`; срок 10 лет; если оба файла есть — не трогает.
- `npm start` = `concurrently -k "vite" ".venv\Scripts\python -m bridge"`; `npm test` = `vitest run`.
- `vite.config.js`: `root: 'web'`, `server: { host: lan_host, port: web_port, strictPort: true, https: {cert, key}, proxy: { '/bridge': { target: 'ws://127.0.0.1:<bridge_port>', ws: true } } }`, значения читает из `config.json`.

- [ ] Тесты: `test_load_config_reads_all_sections` (значения выше); `test_ensure_cert_creates_with_san` (в SAN есть `192.168.0.10`, срок > 9 лет); `test_ensure_cert_is_stable` (второй вызов не меняет байты файлов).
- [ ] Запустить: `.venv\Scripts\python -m pytest tests/test_config.py tests/test_cert.py -q` → FAIL.
- [ ] Создать venv, `requirements.txt`, `npm install`, реализовать `load_config`, `ensure_cert`, `vite.config.js`, страницу-заглушку.
- [ ] Тесты → PASS.
- [ ] Проверка: `npx vite` → `curl -k https://192.168.0.10:5173/` возвращает HTML заглушки.

### Task 2: Звук — устройства и виртуальный микрофон

**Files:** Create `bridge/audio_devices.py`, `bridge/virtual_mic.py`, `tests/test_audio_devices.py`, `tests/test_virtual_mic.py`

**Interfaces — Produces:**
- `class AudioBackend(Protocol)`: `find_capture_id(name) -> str`, `unmute(dev_id)`, `get_default(role: str) -> str`, `set_default(dev_id, role: str)`; роли `"console" | "multimedia" | "communications"`. Реальная реализация `PycawBackend` (вызывает `comtypes.CoInitialize()` в своём потоке).
- `class CaptureDefaults(backend, mic_name: str, state_file: Path)`: `prepare()` (снять mute; если `state_file` есть — восстановить из него и удалить), `switch_to_virtual()` (сохранить три текущих id в `state_file`, поставить виртуальный), `restore()` (вернуть, удалить файл; без сохранённого — no-op).
- `to_cable_frames(pcm_s16le_mono: bytes, gain_db: float) -> np.ndarray` — форма `(n, 2)`, float32, значение = `sample/32768 * 10**(gain_db/20)`.
- `class VirtualMicPlayer(speaker_name: str, gain_db: float)`: `open()`, `feed(pcm: bytes)`, `pending_seconds() -> float`, `close()`. Поток вывода с callback'ом, читающим из потокобезопасной очереди; при пустой очереди — тишина.

- [ ] Тесты (FakeBackend): `test_switch_saves_and_sets_all_roles`; `test_restore_returns_originals_and_removes_state`; `test_prepare_recovers_after_crash` (state_file существует → `prepare()` вернул исходные id); `test_restore_without_switch_is_noop`; `test_to_cable_frames_scales_minus_30db` (вход 16384 → `0.5 * 10**-1.5` в обоих каналах).
- [ ] Интеграционный `@pytest.mark.integration test_tone_arrives_clean`: `VirtualMicPlayer` получает 1 с тона 440 Гц чанками по 960 сэмплов → запись с виртуального микрофона (WASAPI shared): пик 440 ± 3 Гц, отношение амплитуд 0.9–1.1, доля нулевых сэмплов < 1 %.
- [ ] Запустить → FAIL; реализовать; `pytest tests/test_audio_devices.py tests/test_virtual_mic.py -q` и `-m integration` → PASS.

### Task 3: Claude в псевдотерминале

**Files:** Create `bridge/claude_pty.py`, `tests/test_claude_pty.py`, `tests/fixtures/pty_hold.txt` (скопировать запись из пробного прогона)

**Interfaces — Produces:**
- `load_or_create_session(state_file: Path, transcripts_dir: Path) -> tuple[str, bool]` — `(session_id, is_new)`; `is_new=False` только если id сохранён и существует `transcripts_dir/<id>.jsonl`.
- `build_claude_argv(cfg: ClaudeConfig, session_id: str, is_new: bool, settings_file: Path) -> list[str]` — `["claude", "--session-id"|"--resume", id, "--settings", path, "--model", m, "--effort", e, "--append-system-prompt", VR_MARKER, *extra_args]`; `VR_MARKER = "VR_VOICE_SESSION: промпты приходят голосом из VR-шлема. Следуй разделу «VR-режим» в CLAUDE.md."`
- `child_env(environ: Mapping[str, str]) -> dict[str, str]`.
- `strip_ansi(text: str) -> str`; `class ListeningDetector`: `reset()`, `feed(text: str) -> bool` (True, как только после `reset()` встретилось `listening`, в том числе разорванное между двумя вызовами).
- `class PtyHost(argv, cwd, env, cols, rows, on_output: Callable[[str], None], replay_limit=200_000)`: `start()`, `write(data: str)`, `replay() -> str`, `nudge_redraw()` (resize rows-1 и обратно), `stop()`, `alive: bool`. Чтение — в отдельном потоке.

- [ ] Тесты: `test_new_session_persists_id`; `test_existing_session_resumes_only_if_transcript_exists`; `test_argv_new_vs_resume`; `test_child_env_drops_claude_vars` (остаётся `PATH`, пропадают `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`); `test_detector_fires_on_fixture` (на `pty_hold.txt`: False до маркера `<<<HOLD-START>>>`, True после); `test_detector_handles_split_chunks`; `test_ptyhost_echo_and_replay` (спавнит `cmd /c echo hello` → `on_output` получил `hello`, `replay()` его содержит).
- [ ] Запустить → FAIL; реализовать; → PASS.

### Task 4: Диктовка (конечный автомат)

**Files:** Create `bridge/dictation.py`, `tests/test_dictation.py`

**Interfaces:**
- Consumes: `CaptureDefaults`, `VirtualMicPlayer`, `ListeningDetector` (Task 2–3), `pty_write: Callable[[str], None]`.
- Produces: `class Dictation(pty_write, detector, defaults, player, on_state, *, repeat_s=0.033, listen_timeout_s=1.5, tail_s=0.35, min_audio_s=0.25, restore_delay_s=0.5)`; `async press()`, `feed(pcm: bytes)`, `async release()`, `on_pty_output(text: str)`, `state: "idle"|"warmup"|"listening"|"finalizing"`. `on_state(state)` вызывается при каждой смене.

Порядок: `press` → `defaults.switch_to_virtual()` → `player.open()` → повтор пробела; звук копится, пока детектор не увидел `listening` (или не истёк `listen_timeout_s`), затем уходит в `player.feed` в исходном порядке. `release` → дождаться `player.pending_seconds() == 0` + `tail_s` → остановить пробелы → `player.close()` → через `restore_delay_s` `defaults.restore()` → `idle`. Короткое нажатие (накоплено < `min_audio_s`): пробелы остановить сразу; если `listening` не было — послать `"\x7f"` столько раз, сколько послано пробелов; если было — послать `"\x1b"`.

- [ ] Тесты (фейки, малые интервалы): `test_press_switches_mic_before_first_space`; `test_audio_held_until_listening`; `test_listen_timeout_starts_playback`; `test_release_drains_then_stops_spaces_and_restores`; `test_tap_before_listening_erases_spaces`; `test_tap_after_listening_sends_esc`; `test_restore_runs_when_player_open_fails`; `test_press_during_finalizing_waits_for_idle`.
- [ ] Запустить → FAIL; реализовать; → PASS.

### Task 5: Мост — сервер и протокол

**Files:** Create `bridge/server.py`, `bridge/__main__.py`, `tests/test_server.py`, `scripts/e2e_voice.py`

**Interfaces:**
- Consumes: всё из Task 1–4.
- Produces: `create_app(cfg, pty, dictation, status_path: Path, pair_code: str) -> web.Application`; WebSocket `GET /bridge?code=<pair_code>` (неверный код → 401).
  - Клиент → сервер, текст: `{"t":"ptt","down":bool}`, `{"t":"key","k":name}` где `name ∈ {"enter","esc","up","down","tab","shift-tab"}`, `{"t":"scene","ok":bool,"error":str|null}`.
  - Клиент → сервер, бинарно: PCM s16le mono 48000.
  - Сервер → клиент, текст: `{"t":"hello","cols":100,"rows":32}`, `{"t":"voice","state":...}`; бинарно: вывод терминала (UTF-8).
  - При подключении: `hello`, затем `pty.replay()`, затем `pty.nudge_redraw()`. Отключение клиента, державшего курок → `dictation.release()`.
  - `scene` → `status_path` = `{"ok":..,"error":..,"at":"<ISO-8601>"}`.
- `python -m bridge`: `ensure_cert`, код сопряжения (8 символов `a-z0-9`, хранится в `.vr/pair-code`), `CaptureDefaults.prepare()`, запуск `PtyHost`, печать адреса `https://<lan_host>:<web_port>/` и кода.

- [ ] Тесты (aiohttp test client, фейки): `test_rejects_wrong_pair_code` (401); `test_hello_then_replay_on_connect`; `test_binary_frames_reach_dictation_feed`; `test_ptt_calls_press_and_release`; `test_key_whitelist` (`enter` → `"\r"` в pty; `{"t":"key","k":"rm -rf"}` игнорируется); `test_scene_status_written`; `test_output_broadcast_to_two_clients`; `test_disconnect_while_holding_releases`.
- [ ] Запустить → FAIL; реализовать; → PASS.
- [ ] `scripts/e2e_voice.py` (ложный шлем): подключается к `wss://<lan_host>:<web_port>/bridge` через Vite, шлёт `ptt down`, PCM синтезированной фразы «Ответь одним словом: привет.» чанками по 20 мс в реальном времени, `ptt up`; успех — в выводе терминала появились `привет` (распознанный промпт) и ответ Claude. Запуск при работающем `npm start` → `E2E OK`.

### Task 6: Страница — VR-хост и подмена сцены

**Files:** Create `web/src/scene-host.js`, `web/src/scene/main.js`, `web/tests/scene-host.test.js`; Modify `web/src/main.js`, `web/index.html`

**Interfaces — Produces:**
- `class SceneHost(ctx, report)`: `mount(mod)`, `swap(nextMod)`, `update(dt)`. `report({ok: boolean, error: string|null})`. После `dispose()` хост сам очищает `ctx.root` (удаляет детей, освобождает geometry/material/texture).
- `ctx = { THREE, root: THREE.Group, scene, camera, renderer }`.
- `main.js`: `WebGLRenderer` + `renderer.xr.enabled`, пол-сетка и свет вне `root`; кнопка «Войти в VR»; слушатель `navigator.xr.addEventListener('sessiongranted', enterVR)` на верхнем уровне модуля; `import.meta.hot.accept('./scene/main.js', next => next && host.swap(next))`; `import.meta.hot.on('vite:error', ...)` → `report({ok:false, error})`.
- `scene/main.js`: стартовая сцена — вращающийся куб на высоте 1.2 м в 1.5 м перед игроком.

- [ ] Тесты (vitest): `swap disposes old before setting up new`; `failing setup rolls back to previous module and reports error`; `update error is reported once and stops updates until next swap`; `dispose error does not block swap`; `root is emptied after dispose`.
- [ ] `npx vitest run` → FAIL; реализовать; → PASS.
- [ ] Проверка в браузере ПК: открыть страницу, изменить цвет куба в `scene/main.js` → цвет меняется без перезагрузки; вставить `throw` в `setup` → остаётся прежний куб.

### Task 7: Страница — окно терминала

**Files:** Create `web/src/bridge-client.js`, `web/src/terminal-panel.js`, `web/src/term-paint.js`, `web/tests/term-paint.test.js`; Modify `web/src/main.js`, `web/index.html`

**Interfaces:**
- Consumes: протокол Task 5.
- Produces:
  - `createBridge({onBinary, onMessage, onStatus}) -> { send(obj), sendBinary(buf), connected }` — код сопряжения из `localStorage['pairCode']` (если нет — поле ввода на 2D-странице), переподключение раз в 1 с.
  - `rowRuns(cells: {ch, fg, bg, bold, dim, inverse, width}[]) -> {x, text, fg, bg, bold, dim}[]` — подряд идущие ячейки с одинаковым стилем склеены, `inverse` уже применён (fg/bg поменяны местами).
  - `createTerminalPanel({cols, rows, renderer}) -> { mesh, write(bytes), scrollLines(n), setVoiceState(s), tick(nowMs) }` — `@xterm/xterm` разбирает поток; canvas перерисовывается из `term.buffer.active` не чаще раза в 66 мс и только при изменениях; шрифт JetBrains Mono (дождаться `document.fonts.load`); полоса состояния голоса вверху (красная при `listening`). Панель: ширина 1.6 м, центр `(0, 1.35, -1.3)`, `MeshBasicMaterial`, `toneMapped: false`, анизотропия максимальная.
  - На 2D-странице тот же терминал виден как обычный элемент.

- [ ] Тесты: `rowRuns merges same-style neighbours`; `rowRuns splits on colour change`; `rowRuns swaps fg/bg for inverse`; `rowRuns skips zero-width cells after wide chars`.
- [ ] → FAIL; реализовать; → PASS.
- [ ] Проверка в браузере ПК при работающем `npm start`: на странице виден экран Claude Code с рамкой и кириллицей; после перезагрузки страницы экран восстанавливается.

### Task 8: Страница — микрофон и левый контроллер

**Files:** Create `web/src/pcm.js`, `web/src/pcm-worklet.js`, `web/src/mic.js`, `web/src/control-mapper.js`, `web/src/controls.js`, `web/tests/pcm.test.js`, `web/tests/control-mapper.test.js`; Modify `web/src/main.js`

**Interfaces:**
- Consumes: `createBridge`, `createTerminalPanel`.
- Produces:
  - `floatToInt16(Float32Array) -> Int16Array` (ограничение до [-1, 1]).
  - `createMic() -> { acquire(), start(onFrame), stop(), resume() }` — `acquire()` вызывается в обработчике кнопки «Войти в VR» до `requestSession`; после перезагрузки через `sessiongranted` — только если `permissions.query({name:'microphone'})` даёт `granted`. `AudioContext({sampleRate: 48000})`, worklet отдаёт кадры по 960 сэмплов.
  - `class ControlMapper({holdMs = 1000, threshold = 0.6, repeatMs = 200})`: `step(nowMs, {buttons: boolean[], axes: number[]}) -> string[]` из `'enter' | 'esc' | 'scroll-up' | 'scroll-down' | 'arrow-up' | 'arrow-down' | 'reload'`.
  - `controls.js`: `selectstart`/`selectend` на контроллерах 0 и 1 с фильтром левого → `ptt`; `disconnected` и конец сессии → `ptt up`; опрос кнопок каждый кадр через `ControlMapper`; `reload` → `location.reload()`; `scroll-*` → `panel.scrollLines(∓3)`; остальное → `{"t":"key"}`.

- [ ] Тесты: `floatToInt16 clamps and scales` (1.0 → 32767, -1.0 → -32768, 2.0 → 32767); `X rising edge emits enter once`; `Y rising edge emits esc once`; `stick up repeats scroll-up every repeatMs`; `stick with grip emits arrows instead of scroll`; `stick click held 1000 ms emits reload once`; `stick click released early emits nothing`.
- [ ] → FAIL; реализовать; → PASS.

### Task 9: Правила VR-сессии, проверка на ПК, выход на шлем

**Files:** Create `CLAUDE.md`, `README.md`, `scripts/scene-check.mjs`; Modify `package.json` (`"scene:check"`)

**Interfaces — Produces:**
- `npm run scene:check` — ждёт до 10 с, пока `logs/scene-status.json.at` станет новее времени изменения самого свежего файла в `web/src/scene/`; код 0 и `OK`, код 1 и текст ошибки, код 2 и `страница не подключена`.
- `CLAUDE.md`: устройство проекта, запуск, контракт сцены; раздел «VR-режим» (действует, только если в системном промпте есть `VR_VOICE_SESSION`): действовать сразу, без уточняющих вопросов, навыков планирования и обсуждений; отвечать одной-двумя короткими строками без разметки; править файлы в `web/src/scene/`; после каждой правки запускать `npm run scene:check` и чинить ошибку самостоятельно; оболочку и мост менять только по прямой просьбе.
- `README.md`: запуск (`npm start`), одноразовая настройка в шлеме, кнопки, запасные варианты (флаг `chrome://flags/#webxr-navigation-permission`; VB-Cable).

- [ ] Тест `scene-check`: при свежем `ok:true` → код 0; при `ok:false` → код 1 и текст; при устаревшем статусе → код 2 (vitest, временная папка).
- [ ] Полный прогон на ПК: `pytest -q`, `pytest -m integration -q`, `npx vitest run`, `scripts/e2e_voice.py` → всё зелёное.
- [ ] Сквозная проверка без шлема: при открытой в браузере ПК странице `e2e_voice.py` с фразой «Сделай куб зелёным» → куб на странице зеленеет, `npm run scene:check` → `OK`.
- [ ] Сообщить пользователю адрес и код сопряжения; проверка в шлеме по порядку: вход в VR → виден терминал → курок и фраза → подмена сцены → X/Y/стик → принудительная перезагрузка (возврат в VR через `sessiongranted`).
