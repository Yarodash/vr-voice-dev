import json
import time
from pathlib import Path

from bridge.claude_pty import (
    VR_MARKER,
    ListeningDetector,
    PtyHost,
    build_claude_argv,
    child_env,
    load_or_create_session,
    strip_ansi,
    transcripts_dir_for,
)
from bridge.config import ClaudeConfig

FIXTURE = Path(__file__).parent / "fixtures" / "pty_hold.txt"
CFG = ClaudeConfig(model="sonnet", effort="low", extra_args=["--verbose"])


def test_transcripts_dir_for_replaces_separators():
    assert transcripts_dir_for(Path(r"D:\vr_something"), home=Path(r"C:\Users\me")) == Path(
        r"C:\Users\me\.claude\projects\D--vr-something"
    )


def test_new_session_persists_id(tmp_path):
    state = tmp_path / "session.json"

    session_id, is_new = load_or_create_session(state, tmp_path / "transcripts")

    assert is_new is True
    assert json.loads(state.read_text())["session_id"] == session_id
    assert len(session_id) == 36


def test_existing_session_resumes_when_transcript_exists(tmp_path):
    state, transcripts = tmp_path / "session.json", tmp_path / "transcripts"
    first_id, _ = load_or_create_session(state, transcripts)
    transcripts.mkdir()
    (transcripts / f"{first_id}.jsonl").write_text("{}")

    session_id, is_new = load_or_create_session(state, transcripts)

    assert (session_id, is_new) == (first_id, False)


def test_saved_id_without_transcript_starts_that_session_as_new(tmp_path):
    # Claude Code never wrote a transcript (e.g. killed before the first prompt): --resume would fail.
    state, transcripts = tmp_path / "session.json", tmp_path / "transcripts"
    first_id, _ = load_or_create_session(state, transcripts)

    session_id, is_new = load_or_create_session(state, transcripts)

    assert (session_id, is_new) == (first_id, True)


def test_argv_new_session():
    argv = build_claude_argv(CFG, "abc", True, Path("s.json"))

    assert argv == ["claude", "--session-id", "abc", "--settings", "s.json", "--model", "sonnet",
                    "--effort", "low", "--append-system-prompt", VR_MARKER, "--verbose"]


def test_argv_resume_session():
    argv = build_claude_argv(CFG, "abc", False, Path("s.json"))

    assert argv[:3] == ["claude", "--resume", "abc"]


FORK_CFG = ClaudeConfig(model="", effort="medium", extra_args=[], fork_from="source-id")


def test_argv_forks_from_an_existing_conversation():
    # First start: the VR terminal gets a copy of the source conversation under its own id.
    argv = build_claude_argv(FORK_CFG, "new-id", True, Path("s.json"))

    assert argv[:6] == ["claude", "--resume", "source-id", "--fork-session", "--session-id", "new-id"]


def test_argv_resumes_the_fork_itself_afterwards():
    argv = build_claude_argv(FORK_CFG, "new-id", False, Path("s.json"))

    assert argv[:3] == ["claude", "--resume", "new-id"]
    assert "--fork-session" not in argv and "source-id" not in argv


def test_fork_source_is_remembered_with_the_session(tmp_path):
    state = tmp_path / "session.json"

    session_id, is_new = load_or_create_session(state, tmp_path / "transcripts", fork_from="source-id")

    assert is_new is True
    assert json.loads(state.read_text()) == {"session_id": session_id, "forked_from": "source-id"}


def test_same_fork_source_keeps_the_session(tmp_path):
    state, transcripts = tmp_path / "session.json", tmp_path / "transcripts"
    first_id, _ = load_or_create_session(state, transcripts, fork_from="source-id")
    transcripts.mkdir()
    (transcripts / f"{first_id}.jsonl").write_text("{}")

    assert load_or_create_session(state, transcripts, fork_from="source-id") == (first_id, False)


def test_changing_the_fork_source_starts_a_new_session(tmp_path):
    # The saved session belongs to another conversation: resuming it would ignore the new setting.
    state, transcripts = tmp_path / "session.json", tmp_path / "transcripts"
    old_id, _ = load_or_create_session(state, transcripts)
    transcripts.mkdir()
    (transcripts / f"{old_id}.jsonl").write_text("{}")

    session_id, is_new = load_or_create_session(state, transcripts, fork_from="source-id")

    assert session_id != old_id
    assert is_new is True
    assert json.loads(state.read_text())["forked_from"] == "source-id"


def test_argv_skips_empty_model_and_effort():
    argv = build_claude_argv(ClaudeConfig(model="", effort="", extra_args=[]), "abc", True, Path("s.json"))

    assert "--model" not in argv and "--effort" not in argv


def test_child_env_drops_claude_vars():
    env = child_env({"PATH": "x", "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "s", "CLAUDE_PID": "7",
                     "claude_code_entrypoint": "cli", "CLAUDE_CONFIG_DIR": "keep"})

    assert env == {"PATH": "x", "CLAUDE_CONFIG_DIR": "keep"}


def test_strip_ansi_removes_cursor_moves_and_colours():
    assert strip_ansi("\x1b[27;89Hlistening\u2026\x1b[29;3H\x1b[?25h\x1b[38;5;246mok\x1b[0m") == "listening\u2026ok"


def test_detector_fires_on_fixture():
    before, after = FIXTURE.read_text(encoding="utf-8").split("<<<HOLD-START>>>")
    detector = ListeningDetector()
    detector.reset()

    assert detector.feed(before) is False
    detector.reset()
    assert detector.feed(after) is True


def test_detector_handles_split_chunks():
    detector = ListeningDetector()
    detector.reset()

    assert detector.feed("\x1b[27;89Hlist") is False
    assert detector.feed("ening\u2026") is True


def test_detector_is_silent_until_reset():
    detector = ListeningDetector()

    assert detector.feed("listening\u2026") is False


def test_detector_forgets_text_seen_before_reset():
    detector = ListeningDetector()
    detector.reset()
    detector.feed("listening\u2026")

    detector.reset()

    assert detector.feed("something else") is False


def test_ptyhost_echo_and_replay():
    chunks = []
    host = PtyHost(["cmd", "/c", "echo hello"], cwd=str(Path.cwd()), env=None, cols=80, rows=24,
                   on_output=chunks.append)
    host.start()
    deadline = time.time() + 10
    while "hello" not in "".join(chunks) and time.time() < deadline:
        time.sleep(0.05)
    host.stop()

    assert "hello" in "".join(chunks)
    assert "hello" in host.replay()


def test_ptyhost_replay_is_bounded():
    host = PtyHost(["cmd", "/c", "echo x"], cwd=str(Path.cwd()), env=None, cols=80, rows=24,
                   on_output=lambda _: None, replay_limit=10)

    host._remember("0123456789abcdef")

    assert host.replay() == "6789abcdef"
