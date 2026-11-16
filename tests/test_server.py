import asyncio
import json
from pathlib import Path

import aiohttp
import pytest

from bridge.config import load_config
from bridge.server import HUB, create_app, load_or_create_pair_code

ROOT = Path(__file__).resolve().parent.parent


def test_pair_code_is_created_once(tmp_path):
    first = load_or_create_pair_code(tmp_path / ".vr" / "pair-code")

    assert len(first) == 8 and first.isalnum() and first == first.lower()
    assert load_or_create_pair_code(tmp_path / ".vr" / "pair-code") == first


@pytest.mark.parametrize("stored", ["", "short", "has space", "\n"])
def test_pair_code_is_regenerated_when_the_stored_value_is_not_a_code(tmp_path, stored):
    # An empty file must never make the empty string a valid code.
    path = tmp_path / "pair-code"
    path.write_text(stored, encoding="utf-8")

    code = load_or_create_pair_code(path)

    assert len(code) == 8 and code.isalnum()
    assert path.read_text(encoding="utf-8") == code
CODE = "abcd1234"
URL = f"/bridge?code={CODE}"


class FakePty:
    def __init__(self):
        self.written = []
        self.nudges = 0

    def replay(self):
        return "earlier screen"

    def nudge_redraw(self):
        self.nudges += 1

    def write(self, data):
        self.written.append(data)


class FakeDictation:
    state = "idle"

    def __init__(self):
        self.calls = []
        self.frames = []

    async def press(self):
        self.calls.append("press")

    async def release(self):
        self.calls.append("release")

    def feed(self, pcm):
        self.frames.append(pcm)


@pytest.fixture
def parts(tmp_path):
    return FakePty(), FakeDictation(), tmp_path / "logs" / "scene-status.json"


@pytest.fixture
def console_log(tmp_path):
    return tmp_path / "logs" / "page-console.log"


@pytest.fixture
def inbox_log(tmp_path):
    return tmp_path / "logs" / "vr-inbox.log"


@pytest.fixture
def files_dir(tmp_path):
    return tmp_path / "logs" / "screenshots"


@pytest.fixture
async def client(aiohttp_client, parts, console_log, files_dir, inbox_log):
    pty, dictation, status_path = parts
    app = create_app(load_config(ROOT / "config.json"), pty, dictation, status_path, CODE, console_log, files_dir,
                     inbox_log)
    return await aiohttp_client(app)


async def connect(client):
    ws = await client.ws_connect(URL)
    hello = await ws.receive_json()
    replay = await ws.receive_bytes()
    return ws, hello, replay


async def until(predicate, timeout=2.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        assert loop.time() < deadline, "condition not reached in time"
        await asyncio.sleep(0.005)


async def test_rejects_wrong_pair_code(client):
    with pytest.raises(aiohttp.WSServerHandshakeError) as err:
        await client.ws_connect("/bridge?code=wrong")

    assert err.value.status == 401


async def test_rejects_missing_pair_code(client):
    with pytest.raises(aiohttp.WSServerHandshakeError) as err:
        await client.ws_connect("/bridge")

    assert err.value.status == 401


async def test_rejects_foreign_origin(client):
    with pytest.raises(aiohttp.WSServerHandshakeError) as err:
        await client.ws_connect(URL, headers={"Origin": "https://evil.example"})

    assert err.value.status == 403


async def test_accepts_the_page_origin(client):
    ws = await client.ws_connect(URL, headers={"Origin": "https://192.168.0.10:5173"})

    assert (await ws.receive_json())["t"] == "hello"
    await ws.close()


async def test_hello_then_replay_on_connect(client, parts):
    pty, _, _ = parts

    ws, hello, replay = await connect(client)

    assert hello == {"t": "hello", "cols": 84, "rows": 24, "voice": "idle"}
    assert replay == b"earlier screen"
    await until(lambda: pty.nudges == 1)
    await ws.close()


async def test_binary_frames_reach_dictation_feed(client, parts):
    _, dictation, _ = parts
    ws, _, _ = await connect(client)

    await ws.send_bytes(b"\x01\x02\x03\x04")

    await until(lambda: dictation.frames == [b"\x01\x02\x03\x04"])
    await ws.close()


async def test_ptt_calls_press_and_release(client, parts):
    _, dictation, _ = parts
    ws, _, _ = await connect(client)

    await ws.send_json({"t": "ptt", "down": True})
    await ws.send_json({"t": "ptt", "down": False})

    await until(lambda: dictation.calls == ["press", "release"])
    await ws.close()


async def test_key_whitelist(client, parts):
    pty, _, _ = parts
    ws, _, _ = await connect(client)

    await ws.send_json({"t": "key", "k": "rm -rf"})
    await ws.send_json({"t": "key", "k": "enter"})
    await ws.send_json({"t": "key", "k": "esc"})
    await ws.send_json({"t": "key", "k": "up"})

    await until(lambda: len(pty.written) == 3)
    assert pty.written == ["\r", "\x1b", "\x1b[A"]
    await ws.close()


async def test_page_can_scroll_the_conversation(client, parts):
    pty, _, _ = parts
    ws, _, _ = await connect(client)

    await ws.send_json({"t": "key", "k": "pgup"})
    await ws.send_json({"t": "key", "k": "pgdn"})

    await until(lambda: len(pty.written) == 2)
    assert pty.written == ["\x1b[5~", "\x1b[6~"]
    await ws.close()


async def test_page_can_delete_the_dictated_draft(client, parts):
    pty, _, _ = parts
    ws, _, _ = await connect(client)

    await ws.send_json({"t": "key", "k": "clear"})

    await until(lambda: pty.written == ["\x15" * 20])
    await ws.close()


async def test_voice_error_broadcast(client):
    ws, _, _ = await connect(client)

    client.app[HUB].voice_error("device busy")

    assert await ws.receive_json() == {"t": "voice-error", "error": "device busy"}
    await ws.close()


async def test_malformed_messages_do_not_break_the_connection(client, parts):
    pty, _, _ = parts
    ws, _, _ = await connect(client)

    await ws.send_str("not json")
    await ws.send_json(["not", "an", "object"])
    await ws.send_json({"t": "key", "k": "enter"})

    await until(lambda: pty.written == ["\r"])
    await ws.close()


async def test_scene_status_written(client, parts):
    _, _, status_path = parts
    ws, _, _ = await connect(client)

    await ws.send_json({"t": "scene", "ok": False, "error": "boom is not defined"})

    await until(status_path.exists)
    status = json.loads(status_path.read_text(encoding="utf-8"))
    assert status["ok"] is False
    assert status["error"] == "boom is not defined"
    assert status["at"].endswith("+00:00")
    await ws.close()


async def test_output_broadcast_to_two_clients(client):
    first, _, _ = await connect(client)
    second, _, _ = await connect(client)

    client.app[HUB].pty_output("привет")

    assert (await first.receive_bytes()).decode() == "привет"
    assert (await second.receive_bytes()).decode() == "привет"
    await first.close()
    await second.close()


async def test_voice_state_broadcast(client):
    ws, _, _ = await connect(client)

    client.app[HUB].voice_state("listening")

    assert await ws.receive_json() == {"t": "voice", "state": "listening"}
    await ws.close()


async def test_disconnect_while_holding_releases(client, parts):
    _, dictation, _ = parts
    ws, _, _ = await connect(client)
    await ws.send_json({"t": "ptt", "down": True})
    await until(lambda: dictation.calls == ["press"])

    await ws.close()

    await until(lambda: dictation.calls == ["press", "release"])


async def test_disconnect_without_holding_does_not_release(client, parts):
    _, dictation, _ = parts
    ws, _, _ = await connect(client)
    await ws.send_json({"t": "ptt", "down": True})
    await ws.send_json({"t": "ptt", "down": False})
    await until(lambda: dictation.calls == ["press", "release"])

    await ws.close()
    await asyncio.sleep(0.05)

    assert dictation.calls == ["press", "release"]


# ---------- remote console: run JavaScript on the page in the headset, read its console ----------

QUEST_UA = "Mozilla/5.0 (X11; Linux x86_64; Quest 3S) AppleWebKit/537.36 OculusBrowser/41.0 Chrome/154.0 VR Safari/537.36"
AUTH = {"X-Pair-Code": CODE}


async def answer_one_eval(ws, **reply):
    message = await ws.receive_json()
    assert message["t"] == "eval"
    await ws.send_json({"t": "eval-result", "id": message["id"], **reply})
    return message


async def test_eval_round_trip(client):
    ws, _, _ = await connect(client)
    page = asyncio.create_task(answer_one_eval(ws, ok=True, value="2"))

    response = await client.post("/eval", json={"code": "1 + 1"}, headers=AUTH)

    assert response.status == 200
    assert await response.json() == {"results": [{"page": "desktop", "ok": True, "value": "2"}]}
    assert (await page)["code"] == "1 + 1"
    await ws.close()


async def test_eval_reports_the_error_from_the_page(client):
    ws, _, _ = await connect(client)
    page = asyncio.create_task(answer_one_eval(ws, ok=False, error="ReferenceError: nope is not defined"))

    response = await client.post("/eval", json={"code": "nope"}, headers=AUTH)

    assert await response.json() == {
        "results": [{"page": "desktop", "ok": False, "error": "ReferenceError: nope is not defined"}]
    }
    await page
    await ws.close()


async def test_eval_labels_the_headset(client):
    ws = await client.ws_connect(URL, headers={"User-Agent": QUEST_UA})
    await ws.receive_json()
    await ws.receive_bytes()
    page = asyncio.create_task(answer_one_eval(ws, ok=True, value="true"))

    response = await client.post("/eval", json={"code": "renderer.xr.isPresenting"}, headers=AUTH)

    assert (await response.json())["results"][0]["page"] == "quest"
    await page
    await ws.close()


async def test_eval_requires_the_pair_code(client):
    ws, _, _ = await connect(client)

    assert (await client.post("/eval", json={"code": "1"})).status == 401
    assert (await client.post("/eval", json={"code": "1"}, headers={"X-Pair-Code": "wrong"})).status == 401
    await ws.close()


async def test_eval_refuses_requests_from_web_pages(client):
    # A site opened in a browser on this PC must not be able to run code in the headset.
    ws, _, _ = await connect(client)

    response = await client.post("/eval", json={"code": "1"}, headers={**AUTH, "Origin": "https://evil.example"})

    assert response.status == 403
    await ws.close()


async def test_eval_without_a_connected_page(client):
    response = await client.post("/eval", json={"code": "1"}, headers=AUTH)

    assert response.status == 409
    assert "не подключена" in (await response.json())["error"]


async def test_eval_reports_a_page_that_does_not_answer(client):
    ws, _, _ = await connect(client)

    response = await client.post("/eval", json={"code": "while(true){}", "timeout": 0.05}, headers=AUTH)

    result = (await response.json())["results"][0]
    assert result["ok"] is False and "нет ответа" in result["error"]
    await ws.close()


@pytest.mark.parametrize("body", [{}, {"code": ""}, {"code": 5}, ["code"]])
async def test_eval_rejects_requests_without_code(client, body):
    ws, _, _ = await connect(client)

    assert (await client.post("/eval", json=body, headers=AUTH)).status == 400
    await ws.close()


async def test_a_stray_eval_result_is_ignored(client, parts):
    pty, _, _ = parts
    ws, _, _ = await connect(client)

    await ws.send_json({"t": "eval-result", "id": "no-such-request", "ok": True, "value": "1"})
    await ws.send_json({"t": "key", "k": "enter"})

    await until(lambda: pty.written == ["\r"])
    await ws.close()


async def test_console_output_is_logged(client, console_log):
    ws, _, _ = await connect(client)

    await ws.send_json({"t": "console", "level": "warn", "text": "куб уехал"})
    await ws.send_json({"t": "console", "level": "error", "text": "TypeError: x is undefined"})

    await until(lambda: console_log.exists() and console_log.read_text(encoding="utf-8").count("\n") == 2)
    first, second = console_log.read_text(encoding="utf-8").splitlines()
    assert "[desktop] WARN  куб уехал" in first
    assert "[desktop] ERROR TypeError: x is undefined" in second
    await ws.close()


async def test_console_log_does_not_grow_without_bound(client, console_log):
    ws, _, _ = await connect(client)
    console_log.parent.mkdir(parents=True, exist_ok=True)
    console_log.write_text("old line\n" * 150_000, encoding="utf-8")  # ~1.3 MB

    await ws.send_json({"t": "console", "level": "log", "text": "newest"})

    await until(lambda: "newest" in console_log.read_text(encoding="utf-8"))
    assert console_log.stat().st_size < 700_000
    await ws.close()


# ---------- files coming back from the page (screenshots) ----------

JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"not really a picture"


async def test_eval_file_result_is_saved_and_its_path_returned(client, files_dir):
    import base64

    ws, _, _ = await connect(client)
    page = asyncio.create_task(answer_one_eval(
        ws, ok=True, value="оба глаза, 2048x1073",
        file={"ext": "jpg", "base64": base64.b64encode(JPEG).decode()}))

    response = await client.post("/eval", json={"code": "await screenshot()"}, headers=AUTH)

    result = (await response.json())["results"][0]
    saved = Path(result["file"])
    assert result["ok"] is True and result["value"] == "оба глаза, 2048x1073"
    assert saved.parent == files_dir and saved.suffix == ".jpg" and "desktop" in saved.name
    assert saved.read_bytes() == JPEG
    await page
    await ws.close()


@pytest.mark.parametrize("file", [
    {"ext": "exe", "base64": "QUJD"},
    {"ext": "../../evil.jpg", "base64": "QUJD"},
    {"ext": "jpg", "base64": "*** not base64 ***"},
    {"ext": "jpg"},
    "not an object",
])
async def test_eval_file_that_is_not_a_plain_image_is_refused(client, files_dir, file):
    ws, _, _ = await connect(client)
    page = asyncio.create_task(answer_one_eval(ws, ok=True, value="x", file=file))

    response = await client.post("/eval", json={"code": "await screenshot()"}, headers=AUTH)

    result = (await response.json())["results"][0]
    assert result["ok"] is False and "файл" in result["error"]
    assert not files_dir.exists() or not any(files_dir.iterdir())
    await page
    await ws.close()


# ---------- prompts dictated in the headset -> the Claude session on the PC (its monitor) ----------

INBOX = f"/inbox?code={CODE}"


async def test_sent_prompt_reaches_the_monitor_and_clears_the_hidden_prompt(client, parts, inbox_log):
    pty, _, _ = parts
    monitor = await client.ws_connect(INBOX)
    page, _, _ = await connect(client)

    await page.send_json({"t": "send", "text": "добавь  пистолет\nпередо мной"})

    assert await monitor.receive_str() == "добавь пистолет передо мной"
    await until(lambda: pty.written == ["\x15" * 20])
    assert "добавь пистолет передо мной" in inbox_log.read_text(encoding="utf-8")
    await page.close()
    await monitor.close()


async def test_prompt_sent_while_no_monitor_is_listening_waits_for_it(client):
    page, _, _ = await connect(client)
    await page.send_json({"t": "send", "text": "первое"})
    await page.send_json({"t": "send", "text": "второе"})
    await asyncio.sleep(0.05)

    monitor = await client.ws_connect(INBOX)

    assert await monitor.receive_str() == "первое"
    assert await monitor.receive_str() == "второе"
    await page.close()
    await monitor.close()


async def test_a_delivered_prompt_is_not_repeated_to_the_next_monitor(client):
    first = await client.ws_connect(INBOX)
    page, _, _ = await connect(client)
    await page.send_json({"t": "send", "text": "один раз"})
    assert await first.receive_str() == "один раз"
    await first.close()

    second = await client.ws_connect(INBOX)
    await page.send_json({"t": "send", "text": "новое"})

    assert await second.receive_str() == "новое"
    await page.close()
    await second.close()


async def test_blank_send_is_ignored(client, parts):
    pty, _, _ = parts
    monitor = await client.ws_connect(INBOX)
    page, _, _ = await connect(client)

    await page.send_json({"t": "send", "text": "   "})
    await page.send_json({"t": "send"})
    await page.send_json({"t": "send", "text": "настоящее"})

    assert await monitor.receive_str() == "настоящее"
    assert pty.written == ["\x15" * 20]
    await page.close()
    await monitor.close()


async def test_inbox_is_closed_to_strangers(client):
    with pytest.raises(aiohttp.WSServerHandshakeError) as wrong_code:
        await client.ws_connect("/inbox?code=wrong")
    with pytest.raises(aiohttp.WSServerHandshakeError) as from_a_web_page:
        await client.ws_connect(INBOX, headers={"Origin": "https://192.168.0.10:5173"})

    assert wrong_code.value.status == 401
    assert from_a_web_page.value.status == 403


# ---------- answers from the PC -> a pop-up in the headset ----------

async def test_say_shows_up_on_the_page(client):
    page, _, _ = await connect(client)

    response = await client.post("/say", json={"text": "Готово: пистолет перед вами."}, headers=AUTH)

    assert response.status == 200
    message = await page.receive_json()
    assert message["t"] == "say" and message["text"] == "Готово: пистолет перед вами." and message["id"]
    await page.close()


async def test_unread_answers_are_shown_to_a_page_that_connects_later(client):
    await client.post("/say", json={"text": "первый ответ"}, headers=AUTH)
    await client.post("/say", json={"text": "второй ответ"}, headers=AUTH)

    page, _, _ = await connect(client)

    first, second = await page.receive_json(), await page.receive_json()
    assert [first["text"], second["text"]] == ["первый ответ", "второй ответ"]
    await page.close()


async def test_an_answer_closed_in_the_headset_is_not_shown_again(client):
    page, _, _ = await connect(client)
    await client.post("/say", json={"text": "прочитано"}, headers=AUTH)
    await client.post("/say", json={"text": "ещё не прочитано"}, headers=AUTH)
    read = await page.receive_json()
    await page.receive_json()
    await page.send_json({"t": "read", "id": read["id"]})
    await asyncio.sleep(0.05)
    await page.close()

    later, _, _ = await connect(client)

    assert (await later.receive_json())["text"] == "ещё не прочитано"
    await later.close()


@pytest.mark.parametrize("headers, body, status", [
    ({}, {"text": "x"}, 401),
    ({"X-Pair-Code": CODE, "Origin": "https://evil.example"}, {"text": "x"}, 403),
    ({"X-Pair-Code": CODE}, {"text": "  "}, 400),
    ({"X-Pair-Code": CODE}, {}, 400),
])
async def test_say_rejects_bad_requests(client, headers, body, status):
    assert (await client.post("/say", json=body, headers=headers)).status == status
