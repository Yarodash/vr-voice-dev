"""The bridge's network face.

WebSocket /bridge — the page in the headset (reached through Vite's proxy):
  page -> bridge   text  {"t":"ptt","down":bool} | {"t":"key","k":name}
                         {"t":"scene","ok":bool,"error":str|null}
                         {"t":"console","level":str,"text":str}
                         {"t":"send","text":str}        (the dictated prompt, "send" pressed)
                         {"t":"read","id":str}          (a pop-up message was closed)
                         {"t":"eval-result","id":str,"ok":bool,"value"|"error":str,
                          "file":{"ext":"jpg"|"png","base64":str}}   (file is optional: a screenshot)
                   bytes microphone audio, PCM s16le mono 48 kHz
  bridge -> page   text  {"t":"hello","cols","rows","voice"} | {"t":"voice","state":...}
                         {"t":"voice-error","error":str} | {"t":"eval","id":str,"code":str}
                         {"t":"say","id":str,"text":str}
                   bytes terminal output, UTF-8

WebSocket /inbox — the Claude Code session on this PC listens here (its Monitor): every prompt
the user sends from the headset arrives as one text frame. Prompts sent while nobody listens wait.
Phrases starting with «конфиг» skip /inbox: a headless Haiku (bridge/config_agent.py) handles them
and its answer is shown like a /say message, prefixed with «⚙ ».

POST /say — shows a message from that session in a pop-up in the headset; it stays "unread"
(and is shown again after a page reload) until the user closes it there.

POST /eval — local tools on this PC (scripts/vr-eval.mjs): runs JavaScript on the connected
pages and returns what they answered. Needs the pairing code in the X-Pair-Code header.
"""
import asyncio
import base64
import binascii
import hmac
import json
import logging
import re
import secrets
import string
import uuid
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import WSMsgType, web

from bridge.config_agent import is_config_phrase

log = logging.getLogger(__name__)

# The page can only press these keys; everything else reaches Claude through dictation.
KEYS = {
    "enter": "\r",
    "esc": "\x1b",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "tab": "\t",
    "shift-tab": "\x1b[Z",
    "pgup": "\x1b[5~",  # Claude Code draws on the alternate screen and scrolls itself
    "pgdn": "\x1b[6~",
    # Ctrl+U deletes one line of the prompt at a time, and a long dictation wraps into several.
    "clear": "\x15" * 20,
}
MAX_ERROR_CHARS = 4000
MAX_CONSOLE_CHARS = 4000
CONSOLE_LOG_LIMIT = 1_000_000  # bytes; the newest half is kept when the file grows past this
EVAL_TIMEOUT_S = 10.0
EVAL_TIMEOUT_MAX_S = 60.0
MAX_UNREAD = 20  # answers kept for the headset; older ones are dropped
FILE_TYPES = {"jpg", "png"}  # what a page may hand back as a file (screenshots)
MAX_MESSAGE_BYTES = 32 << 20  # a two-eye screenshot as base64 is a few megabytes


def load_or_create_pair_code(path: Path) -> str:
    path = Path(path)
    if path.exists():
        stored = path.read_text(encoding="utf-8").strip()
        if len(stored) == 8 and stored.isalnum():
            return stored
        # Anything else (an emptied file above all) must not become the accepted code.
    code = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(8))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(code, encoding="utf-8")
    return code


def page_label(user_agent: str) -> str:
    return "quest" if re.search(r"OculusBrowser|Quest", user_agent or "") else "desktop"


class Hub:
    """Fans terminal output, voice state and eval requests out to every connected page, in order."""

    def __init__(self):
        self._queues: dict[web.WebSocketResponse, asyncio.Queue] = {}
        self._labels: dict[web.WebSocketResponse, str] = {}

    def add(self, ws: web.WebSocketResponse, label: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._queues[ws] = queue
        self._labels[ws] = label
        return queue

    def remove(self, ws: web.WebSocketResponse) -> None:
        self._queues.pop(ws, None)
        self._labels.pop(ws, None)

    def pages(self) -> list[tuple[web.WebSocketResponse, str]]:
        return list(self._labels.items())

    def pty_output(self, text: str) -> None:
        self._put(text.encode("utf-8"))

    def voice_state(self, state: str) -> None:
        self.send({"t": "voice", "state": state})

    def voice_error(self, text: str) -> None:
        self.send({"t": "voice-error", "error": text})

    def send(self, message: dict) -> None:
        self._put(json.dumps(message, ensure_ascii=False))

    def _put(self, item) -> None:
        for queue in self._queues.values():
            queue.put_nowait(item)


async def _pump(ws: web.WebSocketResponse, queue: asyncio.Queue) -> None:
    while True:
        item = await queue.get()
        if isinstance(item, bytes):
            await ws.send_bytes(item)
        else:
            await ws.send_str(item)


class _PendingEval:
    def __init__(self, pages):
        self.waiting = {ws for ws, _ in pages}
        self.answers: dict[web.WebSocketResponse, dict] = {}
        self.done = asyncio.Event()

    def answer(self, ws, message: dict, save_file) -> None:
        if ws not in self.waiting:
            return
        self.waiting.discard(ws)
        if not message.get("ok"):
            self.answers[ws] = {"ok": False, "error": str(message.get("error"))}
        elif "file" not in message:
            self.answers[ws] = {"ok": True, "value": str(message.get("value"))}
        else:
            try:
                path = save_file(message["file"])
                self.answers[ws] = {"ok": True, "value": str(message.get("value")), "file": str(path)}
            except ValueError as err:
                self.answers[ws] = {"ok": False, "error": f"страница прислала непригодный файл: {err}"}
        if not self.waiting:
            self.done.set()


HUB = web.AppKey("hub", Hub)


CANCEL_WORD = "отмена"


def is_cancelled(text: str) -> bool:
    # The user ends a dictated phrase with the word "отмена" to throw the whole phrase away.
    words = text.lower().replace("ё", "е").split()
    if not words:
        return False
    return words[-1].strip(" .,!?;:…-—\"'«»") == CANCEL_WORD


CONFIG_PREFIX = "⚙ "


def create_app(cfg, pty, dictation, status_path: Path, pair_code: str, console_log: Path,
               files_dir: Path, inbox_log: Path, config_agent=None) -> web.Application:
    """`config_agent` (bridge.config_agent.ConfigAgent or None): phrases starting with «конфиг» go
    to it instead of /inbox, one at a time; without it they go to /inbox like any other phrase."""
    hub = Hub()
    config_phrases: asyncio.Queue[str] = asyncio.Queue()
    config_state = {"pending": 0}  # config phrases queued or running
    status_path, console_log, files_dir = Path(status_path), Path(console_log), Path(files_dir)
    inbox_log = Path(inbox_log)
    monitors: set[web.WebSocketResponse] = set()  # who listens on /inbox right now
    undelivered: list[str] = []  # prompts sent while nobody was listening
    unread: dict[str, str] = {}  # answers the user has not closed in the headset yet, oldest first
    page_origin = f"https://{cfg.lan_host}:{cfg.web_port}"
    pending_evals: dict[str, _PendingEval] = {}

    def code_ok(candidate: str | None) -> bool:
        return hmac.compare_digest((candidate or "").encode(), pair_code.encode())

    def write_scene_status(message: dict) -> None:
        error = message.get("error")
        status = {
            "ok": bool(message.get("ok")),
            "error": str(error)[:MAX_ERROR_CHARS] if error is not None else None,
            "at": datetime.now(timezone.utc).isoformat(),
        }
        status_path.parent.mkdir(parents=True, exist_ok=True)
        status_path.write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")

    def append_console(label: str, message: dict) -> None:
        level = str(message.get("level", "log")).upper()[:5]
        text = str(message.get("text", ""))[:MAX_CONSOLE_CHARS].replace("\n", "\n    ")
        console_log.parent.mkdir(parents=True, exist_ok=True)
        if console_log.exists() and console_log.stat().st_size > CONSOLE_LOG_LIMIT:
            tail = console_log.read_bytes()[-CONSOLE_LOG_LIMIT // 2:]
            console_log.write_bytes(tail[tail.find(b"\n") + 1:])
        with console_log.open("a", encoding="utf-8") as out:
            out.write(f"{datetime.now():%H:%M:%S} [{label}] {level:<5} {text}\n")

    def save_page_file(label: str, file) -> Path:
        """Stores an image a page sent back and returns its path. Raises ValueError if it is not one."""
        if not isinstance(file, dict) or file.get("ext") not in FILE_TYPES:
            raise ValueError("ожидалась картинка jpg или png")
        try:
            data = base64.b64decode(file.get("base64") or "", validate=True)
        except (binascii.Error, TypeError, ValueError):
            raise ValueError("содержимое не в base64") from None
        if not data:
            raise ValueError("пустое содержимое")
        files_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
        path = files_dir / f"{stamp}-{label}.{file['ext']}"
        path.write_bytes(data)
        return path

    async def deliver(monitor, line: str) -> None:
        try:
            await monitor.send_str(line)
        except Exception:  # the listener went away between the check and the send
            monitors.discard(monitor)
            undelivered.append(line)

    def log_phrase(line: str) -> None:
        inbox_log.parent.mkdir(parents=True, exist_ok=True)
        with inbox_log.open("a", encoding="utf-8") as out:
            out.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {line}\n")

    def queue_prompt(text: str) -> None:
        line = " ".join(text.split())
        log_phrase(line)
        if monitors:
            for monitor in list(monitors):
                asyncio.ensure_future(deliver(monitor, line))
        else:
            undelivered.append(line)

    def say_message(answer_id: str) -> str:
        return json.dumps({"t": "say", "id": answer_id, "text": unread[answer_id]}, ensure_ascii=False)

    def push_say(text: str) -> str:
        """Shows a message in the headset (unread until the user closes it there)."""
        answer_id = uuid.uuid4().hex
        unread[answer_id] = text.strip()
        while len(unread) > MAX_UNREAD:
            del unread[next(iter(unread))]
        hub._put(say_message(answer_id))
        return answer_id

    async def run_config_agent() -> None:
        while True:
            phrase = await config_phrases.get()
            try:
                answer = await config_agent.run(phrase)
            except asyncio.CancelledError:
                raise
            except Exception as err:
                if not isinstance(err, RuntimeError):
                    log.exception("config agent crashed")
                answer = f"ошибка: {err}"
            finally:
                config_state["pending"] -= 1
            push_say(CONFIG_PREFIX + answer)

    async def config_worker(app: web.Application):
        task = asyncio.create_task(run_config_agent()) if config_agent is not None else None
        yield
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def handle_text(ws, label: str, raw: str, holding: bool) -> bool:
        message = json.loads(raw)
        if not isinstance(message, dict):
            return holding
        kind = message.get("t")
        if kind == "ptt":
            if message.get("down"):
                holding = True
                await dictation.press()
            else:
                holding = False
                await dictation.release()
        elif kind == "key":
            sequence = KEYS.get(message.get("k"))
            if sequence is not None:
                pty.write(sequence)
        elif kind == "scene":
            write_scene_status(message)
        elif kind == "console":
            append_console(label, message)
        elif kind == "send":
            text = message.get("text")
            if isinstance(text, str) and text.strip():
                if is_cancelled(text):  # "... отмена": the phrase is dropped, nothing is sent
                    await ws.send_json({"t": "cancelled"})
                elif config_agent is not None and is_config_phrase(text):
                    # "конфиг ...": a headless Haiku changes the setting; the main session never sees it
                    line = " ".join(text.split())
                    log.info("config phrase queued: %s", line)
                    log_phrase(f"[config agent] {line}")
                    busy = config_state["pending"] > 0
                    config_state["pending"] += 1
                    push_say(CONFIG_PREFIX + ("в очереди…" if busy else "меняю…"))
                    config_phrases.put_nowait(line)
                else:
                    queue_prompt(text)
                pty.write(KEYS["clear"])  # the words are on their way (or dropped): empty the hidden prompt
        elif kind == "read":
            unread.pop(message.get("id"), None)
        elif kind == "eval-result":
            pending = pending_evals.get(message.get("id"))
            if pending is not None:
                pending.answer(ws, message, lambda file: save_page_file(label, file))
        return holding

    async def bridge(request: web.Request) -> web.WebSocketResponse:
        # Vite's proxy does not check the Origin; without this any web page opened on this PC
        # could talk to the terminal. Non-browser clients send no Origin at all.
        origin = request.headers.get("Origin")
        if origin is not None and origin != page_origin:
            raise web.HTTPForbidden()
        if not code_ok(request.query.get("code")):
            raise web.HTTPUnauthorized()

        label = page_label(request.headers.get("User-Agent", ""))
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MESSAGE_BYTES)
        await ws.prepare(request)
        queue = hub.add(ws, label)
        for answer_id in unread:  # shown again after a reload until the user closes them
            queue.put_nowait(say_message(answer_id))
        sender = None
        holding = False
        try:
            await ws.send_json({"t": "hello", "cols": cfg.terminal.cols, "rows": cfg.terminal.rows,
                                "voice": dictation.state})
            await ws.send_bytes(pty.replay().encode("utf-8"))
            sender = asyncio.create_task(_pump(ws, queue))
            await asyncio.to_thread(pty.nudge_redraw)
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    dictation.feed(msg.data)
                elif msg.type == WSMsgType.TEXT:
                    try:
                        holding = await handle_text(ws, label, msg.data, holding)
                    except Exception:
                        log.exception("bad message from the page: %.200s", msg.data)
        finally:
            hub.remove(ws)
            if sender is not None:
                sender.cancel()
            if holding:  # the page vanished mid-sentence: let go of the "key"
                await dictation.release()
        return ws

    async def run_on_pages(request: web.Request) -> web.Response:
        # Reachable only from this PC (the bridge listens on 127.0.0.1). A browser always sends
        # an Origin with a cross-site POST, a local script does not — and only a local script
        # can read the pairing code from disk.
        if request.headers.get("Origin") is not None:
            raise web.HTTPForbidden()
        if not code_ok(request.headers.get("X-Pair-Code")):
            raise web.HTTPUnauthorized()
        try:
            body = await request.json()
        except ValueError:
            raise web.HTTPBadRequest(text="expected a JSON body") from None
        code = body.get("code") if isinstance(body, dict) else None
        if not isinstance(code, str) or not code.strip():
            raise web.HTTPBadRequest(text='expected {"code": "<javascript>"}')
        try:
            timeout = min(float(body.get("timeout", EVAL_TIMEOUT_S)), EVAL_TIMEOUT_MAX_S)
        except (TypeError, ValueError):
            timeout = EVAL_TIMEOUT_S

        pages = hub.pages()
        if not pages:
            return web.json_response({"error": "страница не подключена"}, status=409)

        eval_id = uuid.uuid4().hex
        pending = pending_evals[eval_id] = _PendingEval(pages)
        try:
            hub.send({"t": "eval", "id": eval_id, "code": code})
            try:
                await asyncio.wait_for(pending.done.wait(), timeout)
            except asyncio.TimeoutError:
                pass
        finally:
            del pending_evals[eval_id]
        silent = {"ok": False, "error": f"нет ответа за {timeout:g} с"}
        return web.json_response(
            {"results": [{"page": label, **pending.answers.get(ws, silent)} for ws, label in pages]},
            dumps=lambda data: json.dumps(data, ensure_ascii=False),
        )

    def check_local_caller(request: web.Request, code: str | None) -> None:
        # Only a program on this PC may call: browsers always send an Origin, and only a local
        # program can read the pairing code from disk.
        if request.headers.get("Origin") is not None:
            raise web.HTTPForbidden()
        if not code_ok(code):
            raise web.HTTPUnauthorized()

    async def inbox(request: web.Request) -> web.WebSocketResponse:
        check_local_caller(request, request.query.get("code"))
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        waiting = list(undelivered)
        undelivered.clear()
        monitors.add(ws)
        try:
            for line in waiting:
                await deliver(ws, line)
            async for _ in ws:
                pass
        finally:
            monitors.discard(ws)
        return ws

    async def say(request: web.Request) -> web.Response:
        check_local_caller(request, request.headers.get("X-Pair-Code"))
        try:
            body = await request.json()
        except ValueError:
            raise web.HTTPBadRequest(text="expected a JSON body") from None
        text = body.get("text") if isinstance(body, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise web.HTTPBadRequest(text='expected {"text": "<message>"}')
        answer_id = push_say(text)
        return web.json_response({"id": answer_id, "pages": len(hub.pages())})

    app = web.Application()
    app[HUB] = hub
    app.cleanup_ctx.append(config_worker)
    app.router.add_get("/bridge", bridge)
    app.router.add_get("/inbox", inbox)
    app.router.add_post("/say", say)
    app.router.add_post("/eval", run_on_pages)
    return app
