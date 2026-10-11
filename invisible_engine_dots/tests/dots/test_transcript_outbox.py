"""Outbox rows written with a transcript append."""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest

from nanobot.agent.transcript_metadata import METADATA_KEY
from nanobot.dots import store as s
from nanobot.dots import transcript_outbox as t
from nanobot.dots.store import DotStore

TS = "2026-10-04T10:00:00.000Z"
CHAT = s.CHAT_SESSION_KEY


def final(text: str) -> dict[str, Any]:
    return {"role": "assistant", "content": [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": text}]}


def user(text: str, inbound_id: str | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "user", "content": text}
    if inbound_id is not None:
        message[METADATA_KEY] = {t.INBOUND_ID: inbound_id}
    return message


def tool_result(call_id: str, name: str = "exec", content: str = "done", **metadata: Any) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "tool", "tool_call_id": call_id, "name": name, "content": content}
    if metadata:
        message[METADATA_KEY] = metadata
    return message


class Transcript:
    """Append messages to a store the way the turn runner does, and read the outbox back."""

    def __init__(self, store: DotStore) -> None:
        self.store = store

    def append(self, session_key: str, message: Any, *, final: bool = False) -> None:
        self.store.write(lambda c: s.append_messages(c, session_key, [message], final_index=0 if final else None))

    def events(self) -> list[tuple[str, dict[str, Any]]]:
        return [(e["type"], e["data"]) for e in self.store.read(lambda c: s.read_outbox_after(c, 0, 100))]

    def inbound(self, state: s.InboundState) -> list[str]:
        return [r.id for r in self.store.read(lambda c: s.list_inbound(c, state))]


@pytest.fixture
def transcript(dot_store: DotStore) -> Transcript:
    return Transcript(dot_store)


def accept(store: DotStore, inbound_id: str, type_: str = "user.message") -> None:
    store.write(lambda c: s.record_inbound(c, {"id": inbound_id, "type": type_, "ts": TS, "data": {"text": inbound_id}}, "accepted"))


def start_task(store: DotStore, task_id: str = "t1") -> str:
    store.write(lambda c: s.enqueue_task(c, task_id=task_id, description="do it", priority=0))
    store.write(lambda c: s.start_task(c, task_id))
    return s.task_session_key(task_id)


class TestMessageText:
    def test_a_string_is_stripped(self) -> None:
        assert t.message_text({"content": " two words "}) == "two words"

    def test_text_parts_are_joined_and_other_parts_dropped(self) -> None:
        message = {"content": [{"type": "text", "text": " a"}, {"type": "image_url"}, {"type": "text", "text": "b "}]}
        assert t.message_text(message) == "ab"
        assert t.message_text(final(" two words ")) == "two words"

    @pytest.mark.parametrize("content", [None, 5, {"type": "text", "text": "x"}, []])
    def test_anything_else_is_empty(self, content: object) -> None:
        assert t.message_text({"content": content}) == ""
        assert t.message_text({}) == ""


class TestErrorResults:
    def test_a_result_is_an_error_when_flagged_or_when_its_text_starts_with_error(self) -> None:
        assert t.tool_result_is_error(tool_result("c", content="Error: no such file")) is True
        assert t.tool_result_is_error(tool_result("c", content="Error applying patch: x")) is True
        assert t.tool_result_is_error(tool_result("c", content="fine", is_error=True)) is True
        assert t.tool_result_is_error({"role": "tool", "content": [{"type": "text", "text": "Error: x"}]}) is True

    def test_other_results_are_not(self) -> None:
        assert t.tool_result_is_error(tool_result("c", content="done")) is False
        assert t.tool_result_is_error(tool_result("c", content="no Error here")) is False
        assert t.tool_result_is_error(tool_result("c", content="ok", is_error=False)) is False
        assert t.tool_result_is_error({"role": "tool", "content": None}) is False


class TestAnswers:
    def test_answers_the_chat_in_reply_to_the_newest_user_message_the_transcript_holds(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        for inbound_id in ("m1", "m2"):
            accept(dot_store, inbound_id)
            transcript.append(CHAT, user(inbound_id, inbound_id))
        transcript.append(CHAT, final("both answered"), final=True)
        assert transcript.events() == [("message.assistant", {"text": "both answered", "in_reply_to": "m2", "spent_usd": 0.0})]
        assert transcript.inbound("applied") == ["m1", "m2"]

    def test_sends_an_answer_nobody_asked_for_without_in_reply_to(self, transcript: Transcript) -> None:
        transcript.append(CHAT, final("unprompted"), final=True)
        assert transcript.events() == [("message.assistant", {"text": "unprompted", "spent_usd": 0.0})]

    def test_an_automation_firing_is_applied_but_never_named_in_in_reply_to(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        accept(dot_store, "m1")
        accept(dot_store, "cron:j:5", "automation.fired")
        transcript.append(CHAT, user("hello", "m1"))
        transcript.append(CHAT, user('[Automation "j" fired] check', "cron:j:5"))
        transcript.append(CHAT, final("answered"), final=True)
        assert transcript.events() == [("message.assistant", {"text": "answered", "in_reply_to": "m1", "spent_usd": 0.0})]
        assert transcript.inbound("applied") == ["m1", "cron:j:5"]

    def test_an_answer_to_an_automation_alone_has_no_in_reply_to(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        accept(dot_store, "cron:j:6", "automation.fired")
        transcript.append(CHAT, user("[Automation fired]", "cron:j:6"))
        transcript.append(CHAT, final("done it"), final=True)
        assert transcript.events() == [("message.assistant", {"text": "done it", "spent_usd": 0.0})]
        assert transcript.inbound("applied") == ["cron:j:6"]

    def test_the_final_flag_decides_not_the_shape_of_the_message(self, transcript: Transcript) -> None:
        transcript.append(CHAT, final("a step on the way"))
        transcript.append(CHAT, {"role": "assistant", "content": "tools next", "tool_calls": [{"id": "1"}]})
        assert transcript.events() == []
        transcript.append(CHAT, final("the answer"), final=True)
        assert transcript.events() == [("message.assistant", {"text": "the answer", "spent_usd": 0.0})]

    def test_completes_a_running_task_with_its_final_answer_once(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        transcript.append(session, final("the summary"), final=True)
        transcript.append(session, final("a second answer"), final=True)
        assert dot_store.read(lambda c: s.get_task(c, "t1")).status == "completed"
        assert transcript.events() == [("task.completed", {"task_id": "t1", "summary": "the summary", "spent_usd": 0.0})]

    def test_does_not_complete_a_task_that_is_not_running(self, dot_store: DotStore, transcript: Transcript) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t1", description="d", priority=0))
        transcript.append(s.task_session_key("t1"), final("early"), final=True)
        start_task(dot_store, "t2")
        dot_store.write(lambda c: s.finish_task(c, "t2", "cancelled"))
        transcript.append(s.task_session_key("t2"), final("late"), final=True)
        assert transcript.events() == []
        assert dot_store.read(lambda c: s.get_task(c, "t1")).status == "queued"


def with_calls(text: str | None, *, content: Any = None) -> dict[str, Any]:
    """An assistant message that calls a tool, with the text the model wrote beside the call."""
    return {
        "role": "assistant",
        "content": text if content is None else content,
        "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "exec", "arguments": "{}"}}],
    }


class TestTaskProgress:
    def test_the_text_beside_a_tool_call_of_a_running_task_is_one_progress_event(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        transcript.append(session, with_calls(" Looking at the fares. "))
        assert transcript.events() == [("task.progress", {"task_id": "t1", "text": "Looking at the fares.", "spent_usd": 0.0})]

    def test_the_text_parts_of_the_message_are_the_text_and_thinking_parts_are_not(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        content = [{"type": "thinking", "thinking": "private"}, {"type": "text", "text": "step one"}]
        transcript.append(session, with_calls(None, content=content))
        assert transcript.events() == [("task.progress", {"task_id": "t1", "text": "step one", "spent_usd": 0.0})]

    @pytest.mark.parametrize("content", [None, "", "  \n ", [{"type": "thinking", "thinking": "only thoughts"}]])
    def test_a_call_with_no_text_beside_it_says_nothing(
        self, dot_store: DotStore, transcript: Transcript, content: Any
    ) -> None:
        session = start_task(dot_store)
        transcript.append(session, {**with_calls(None), "content": content})
        assert transcript.events() == []

    def test_text_longer_than_the_limit_is_cut_with_an_ellipsis_to_the_limit(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        transcript.append(session, with_calls("x" * 5000))
        ((kind, data),) = transcript.events()
        assert kind == "task.progress"
        assert data["text"] == "x" * (t.PROGRESS_TEXT_MAX - 1) + "…"
        assert len(data["text"]) == t.PROGRESS_TEXT_MAX

    def test_text_of_exactly_the_limit_is_sent_whole(self, dot_store: DotStore, transcript: Transcript) -> None:
        session = start_task(dot_store)
        transcript.append(session, with_calls("y" * t.PROGRESS_TEXT_MAX))
        assert transcript.events() == [("task.progress", {"task_id": "t1", "text": "y" * t.PROGRESS_TEXT_MAX, "spent_usd": 0.0})]

    def test_every_step_with_text_reports_once_in_order(self, dot_store: DotStore, transcript: Transcript) -> None:
        session = start_task(dot_store)
        transcript.append(session, with_calls("first"))
        transcript.append(session, tool_result("c1"))
        transcript.append(session, with_calls("second"))
        assert [(kind, data.get("text")) for kind, data in transcript.events()] == [
            ("task.progress", "first"),
            ("tool.called", None),
            ("task.progress", "second"),
        ]

    def test_the_chat_never_reports_progress(self, transcript: Transcript) -> None:
        transcript.append(CHAT, with_calls("working on it"))
        assert transcript.events() == []

    @pytest.mark.parametrize("status", ["cancelled", "completed", "failed"])
    def test_a_task_that_is_over_reports_nothing(
        self, dot_store: DotStore, transcript: Transcript, status: str
    ) -> None:
        session = start_task(dot_store)
        dot_store.write(lambda c: s.finish_task(c, "t1", status, summary="over", error="over"))  # type: ignore[arg-type]
        before = transcript.events()
        transcript.append(session, with_calls("too late"))
        assert transcript.events() == before

    def test_a_task_that_has_not_started_reports_nothing(self, dot_store: DotStore, transcript: Transcript) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t1", description="d", priority=0))
        transcript.append(s.task_session_key("t1"), with_calls("early"))
        assert transcript.events() == []

    def test_the_final_answer_is_the_completion_and_never_a_progress_event(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        transcript.append(session, final("all done"), final=True)
        assert [kind for kind, _ in transcript.events()] == ["task.completed"]

    def test_text_without_a_call_that_is_not_the_final_answer_says_nothing(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        transcript.append(session, final("thinking aloud"))
        transcript.append(session, {**with_calls("no calls"), "tool_calls": []})
        assert transcript.events() == []

    def test_the_event_and_the_message_commit_together(self, dot_store: DotStore, transcript: Transcript) -> None:
        session = start_task(dot_store)

        def append_then_fail(conn: sqlite3.Connection) -> None:
            s.append_messages(conn, session, [with_calls("rolled back")], final_index=None)
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            dot_store.write(append_then_fail)
        assert transcript.events() == []
        assert dot_store.read(lambda c: s.read_messages(c, session)) == []


class TestUserMessages:
    def test_marks_a_user_message_by_its_inbound_id_metadata(self, dot_store: DotStore, transcript: Transcript) -> None:
        accept(dot_store, "m1")
        transcript.append(CHAT, {"role": "user", "content": "x"})
        transcript.append(CHAT, {"role": "user", "content": "x", "dots_inbound_id": "m1"})
        transcript.append(CHAT, {"role": "user", "content": "x", METADATA_KEY: {"other": "m1"}})
        assert transcript.inbound("accepted") == ["m1"]
        transcript.append(CHAT, user("x", "m1"))
        assert transcript.inbound("in_transcript") == ["m1"]
        assert transcript.events() == []

    def test_an_inbound_id_in_a_task_session_marks_nothing(self, dot_store: DotStore, transcript: Transcript) -> None:
        session = start_task(dot_store)
        accept(dot_store, "m1")
        transcript.append(session, user("x", "m1"))
        assert transcript.inbound("accepted") == ["m1"]


class TestToolResults:
    def test_reports_a_tool_result_with_its_permission_and_the_time_since_its_intent(
        self, dot_store: DotStore
    ) -> None:
        session = start_task(dot_store)
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("call-1", "exec", session, "t1", 400)))
        dot_store.write(
            lambda c: t.record_transcript_append(c, session, tool_result("call-1", content="Error: failed"), final=False, now_ms=1000)
        )
        assert dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))[0]["data"] == {
            "task_id": "t1",
            "tool": "exec",
            "permission": "computer.exec",
            "decision": "allow",
            "ok": False,
            "duration_ms": 600,
        }
        assert dot_store.read(lambda c: s.take_tool_intent(c, session, "call-1")) is None

    def test_a_chat_result_has_no_task_and_a_call_without_an_intent_took_no_time(self, transcript: Transcript) -> None:
        transcript.append(CHAT, tool_result("call-1", "read_file"))
        assert transcript.events() == [
            ("tool.called", {"tool": "read_file", "permission": "files.read", "decision": "allow", "ok": True, "duration_ms": 0})
        ]

    def test_a_flagged_result_is_not_ok(self, transcript: Transcript) -> None:
        transcript.append(CHAT, tool_result("call-1", content="fine", is_error=True))
        assert transcript.events()[0][1]["ok"] is False

    def test_a_tool_that_is_not_the_dots_reports_no_permission(self, transcript: Transcript) -> None:
        transcript.append(CHAT, tool_result("call-1", "web_fetch"))
        assert transcript.events()[0][1]["permission"] == ""
        transcript.append(CHAT, {"role": "tool", "tool_call_id": "call-2", "content": "x"})
        assert transcript.events()[1][1]["tool"] == "unknown"

    def test_a_tool_of_a_declared_mcp_server_reports_the_servers_permission(self, transcript: Transcript) -> None:
        transcript.append(CHAT, tool_result("call-1", "mcp_time-zones_get_current_time"))
        assert transcript.events()[0][1]["permission"] == "mcp.time-zones"

    def test_reports_the_gates_decision_nothing_for_a_parked_call_and_ask_for_the_approved_call(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        def arrange(c: sqlite3.Connection) -> str:
            approval, _ = s.request_approval(
                c,
                session_key=CHAT,
                task_id=None,
                tool_call_id="call-1",
                tool="exec",
                permission="computer.exec",
                arguments={"command": "ls"},
            )
            s.record_tool_decision(c, CHAT, "call-1", "park")
            s.advance_approval(c, approval.approval_id, "pending", "approved")
            s.advance_approval(c, approval.approval_id, "approved", "granted")
            s.advance_approval(c, approval.approval_id, "granted", "running", run_tool_call_id="call-2")
            s.record_tool_decision(c, CHAT, "call-2", "ask")
            return approval.approval_id

        approval_id = dot_store.write(arrange)
        transcript.append(CHAT, tool_result("call-1", content="This call needs the user's approval"))
        assert transcript.events() == []
        transcript.append(CHAT, tool_result("call-2"))
        assert transcript.events() == [
            ("tool.called", {"tool": "exec", "permission": "computer.exec", "decision": "ask", "ok": True, "duration_ms": 0})
        ]
        assert dot_store.read(lambda c: s.get_approval(c, approval_id)).status == "done"

    def test_a_denied_call_reports_deny_and_not_ok(self, dot_store: DotStore, transcript: Transcript) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "call-1", "deny"))
        transcript.append(CHAT, tool_result("call-1", "write_file", content="fine looking text"))
        assert transcript.events() == [
            ("tool.called", {"tool": "write_file", "permission": "files.write", "decision": "deny", "ok": False, "duration_ms": 0})
        ]

    def test_a_call_skipped_after_a_park_reports_nothing_and_its_decision_is_consumed(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "call-3", "skipped"))
        transcript.append(CHAT, tool_result("call-3", content="Not executed: an earlier call is waiting"))
        assert transcript.events() == []
        assert dot_store.read(lambda c: s.peek_tool_decision(c, CHAT, "call-3")) is None


class TestToolTarget:
    """`tool.called` names what the call acted on, from the target its intent holds (permissions.tool_target)."""

    def intent(self, store: DotStore, target: str | None, session: str = CHAT) -> None:
        task_id = None if session == CHAT else "t1"
        store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("call-1", "exec", session, task_id, 5, target)))

    def test_a_call_that_ran_reports_the_target_of_its_intent(self, dot_store: DotStore, transcript: Transcript) -> None:
        self.intent(dot_store, "ls -la")
        transcript.append(CHAT, tool_result("call-1", content="done"))
        ((kind, data),) = transcript.events()
        assert kind == "tool.called" and data["target"] == "ls -la"
        assert data["ok"] is True

    def test_a_task_call_reports_it_beside_the_task_id(self, dot_store: DotStore, transcript: Transcript) -> None:
        session = start_task(dot_store)
        self.intent(dot_store, "make test", session)
        transcript.append(session, tool_result("call-1"))
        ((_, data),) = transcript.events()
        assert (data["task_id"], data["target"]) == ("t1", "make test")

    def test_a_failed_call_still_says_what_it_tried(self, dot_store: DotStore, transcript: Transcript) -> None:
        self.intent(dot_store, "cat missing.txt")
        transcript.append(CHAT, tool_result("call-1", content="Error: no such file"))
        ((_, data),) = transcript.events()
        assert (data["ok"], data["target"]) == (False, "cat missing.txt")

    def test_an_interrupted_call_says_what_was_cut(self, dot_store: DotStore, transcript: Transcript) -> None:
        self.intent(dot_store, "sleep 600")
        transcript.append(CHAT, tool_result("call-1", content="interrupted", dots_closed=t.CLOSED_INTERRUPTED))
        ((_, data),) = transcript.events()
        assert (data["interrupted"], data["target"]) == (True, "sleep 600")

    def test_an_approved_call_reports_it_with_the_ask_decision(self, dot_store: DotStore, transcript: Transcript) -> None:
        self.intent(dot_store, "rm build")
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "call-1", "ask"))
        transcript.append(CHAT, tool_result("call-1"))
        ((_, data),) = transcript.events()
        assert (data["decision"], data["target"]) == ("ask", "rm build")

    def test_a_call_that_started_a_terminal_session_says_so_beside_its_target(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("call-1", "exec", CHAT, None, 5, "python3", True)))
        transcript.append(CHAT, tool_result("call-1", content="started"))
        ((_, data),) = transcript.events()
        assert (data["target"], data["tty"]) == ("python3", True)

    def test_a_call_that_did_not_leaves_the_key_out(self, dot_store: DotStore, transcript: Transcript) -> None:
        self.intent(dot_store, "ls")
        transcript.append(CHAT, tool_result("call-1"))
        ((_, data),) = transcript.events()
        assert "tty" not in data

    @pytest.mark.parametrize("target", [None, ""])
    def test_an_intent_without_a_target_leaves_the_key_out(
        self, dot_store: DotStore, transcript: Transcript, target: str | None
    ) -> None:
        self.intent(dot_store, target)
        transcript.append(CHAT, tool_result("call-1"))
        ((_, data),) = transcript.events()
        assert "target" not in data

    def test_a_call_that_never_started_has_no_intent_and_so_no_target(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "call-1", "deny"))
        transcript.append(CHAT, tool_result("call-1", content="The Dot's policy denied this call."))
        ((_, data),) = transcript.events()
        assert data["decision"] == "deny" and "target" not in data


class TestClosedCalls:
    def test_an_interrupted_call_reports_tool_called_interrupted(self, dot_store: DotStore, transcript: Transcript) -> None:
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("call-1", "exec", CHAT, None, 5)))
        transcript.append(CHAT, tool_result("call-1", content="This call was interrupted", dots_closed=t.CLOSED_INTERRUPTED))
        assert transcript.events() == [
            (
                "tool.called",
                {
                    "tool": "exec",
                    "permission": "computer.exec",
                    "decision": "allow",
                    "ok": False,
                    "duration_ms": 0,
                    "interrupted": True,
                },
            )
        ]
        assert dot_store.read(lambda c: s.take_tool_intent(c, CHAT, "call-1")) is None

    def test_an_interrupted_approved_call_keeps_its_decision_and_ends_its_approval(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        def arrange(c: sqlite3.Connection) -> str:
            approval, _ = s.request_approval(
                c, session_key=CHAT, task_id=None, tool_call_id="call-1", tool="exec", permission="computer.exec", arguments={}
            )
            for before, after in (("pending", "approved"), ("approved", "granted")):
                s.advance_approval(c, approval.approval_id, before, after)  # type: ignore[arg-type]
            s.advance_approval(c, approval.approval_id, "granted", "running", run_tool_call_id="call-2")
            s.record_tool_decision(c, CHAT, "call-2", "ask")
            s.record_tool_intent(c, s.ToolIntent("call-2", "exec", CHAT, None, 5))
            return approval.approval_id

        approval_id = dot_store.write(arrange)
        transcript.append(CHAT, tool_result("call-2", dots_closed=t.CLOSED_INTERRUPTED))
        event = transcript.events()[0][1]
        assert (event["decision"], event["ok"], event["interrupted"]) == ("ask", False, True)
        assert dot_store.read(lambda c: s.get_approval(c, approval_id)).status == "done"

    def test_a_call_that_never_ran_reports_nothing(self, dot_store: DotStore, transcript: Transcript) -> None:
        transcript.append(CHAT, tool_result("call-1", content="Not executed: the unit ended", dots_closed=t.CLOSED_NOT_RUN))
        assert transcript.events() == []

    def test_a_call_closed_as_denied_reports_deny(self, dot_store: DotStore, transcript: Transcript) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "call-1", "deny"))
        transcript.append(CHAT, tool_result("call-1", content="The Dot's policy denied this call."))
        assert transcript.events()[0][1]["decision"] == "deny"

    def test_a_call_closed_while_parked_reports_nothing(self, dot_store: DotStore, transcript: Transcript) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "call-1", "park"))
        transcript.append(CHAT, tool_result("call-1", content="This call needs the user's approval"))
        assert transcript.events() == []


class TestIgnored:
    def test_ignores_unknown_sessions_and_messages_that_do_not_answer(self, transcript: Transcript) -> None:
        transcript.append("task:unknown", final("not ours"), final=True)
        transcript.append("other", final("not ours either"), final=True)
        transcript.append("task:unknown", tool_result("call-1"))
        transcript.append(CHAT, {"role": "assistant", "content": "cut"})
        transcript.append(CHAT, {"role": "system", "content": "x"})
        assert transcript.events() == []

    def test_leaves_nothing_behind_when_the_transcript_transaction_rolls_back(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, {"id": "m1", "type": "user.message", "ts": TS, "data": {"text": "x"}}, "in_transcript"))

        def failing(c: sqlite3.Connection) -> None:
            t.record_transcript_append(c, CHAT, final("lost"), final=True)
            raise RuntimeError("the transcript insert failed")

        with pytest.raises(RuntimeError):
            dot_store.write(failing)
        assert dot_store.read(lambda c: s.read_outbox_after(c, 0, 10)) == []
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "in_transcript"))] == ["m1"]


class TestSpentUsd:
    """The events that report spend carry what their own session has spent, read in the same transaction."""

    def spend(self, store: DotStore, session_key: str, usd: float) -> None:
        store.write(lambda c: s.add_spend(c, session_key, usd))

    def test_progress_and_completion_of_a_task_carry_the_spend_of_that_task_so_far(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        self.spend(dot_store, session, 0.25)
        transcript.append(session, with_calls("step one"))
        self.spend(dot_store, session, 0.5)
        transcript.append(session, with_calls("step two"))
        self.spend(dot_store, session, 0.125)
        transcript.append(session, final("all done"), final=True)
        assert [(kind, data["spent_usd"]) for kind, data in transcript.events()] == [
            ("task.progress", 0.25),
            ("task.progress", 0.75),
            ("task.completed", 0.875),
        ]

    def test_the_chat_answer_carries_the_spend_of_the_chat_and_not_of_a_task(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        self.spend(dot_store, session, 3.0)
        self.spend(dot_store, CHAT, 0.0625)
        accept(dot_store, "m1")
        transcript.append(CHAT, user("hi", "m1"))
        transcript.append(CHAT, final("hello"), final=True)
        assert transcript.events() == [
            ("message.assistant", {"text": "hello", "in_reply_to": "m1", "spent_usd": 0.0625})
        ]

    def test_the_spend_of_a_task_is_that_of_its_own_session(self, dot_store: DotStore, transcript: Transcript) -> None:
        session = start_task(dot_store, "t1")
        self.spend(dot_store, session, 0.5)
        self.spend(dot_store, CHAT, 9.0)
        self.spend(dot_store, s.task_session_key("t2"), 7.0)
        transcript.append(session, final("done"), final=True)
        assert transcript.events() == [("task.completed", {"task_id": "t1", "summary": "done", "spent_usd": 0.5})]

    def test_a_tool_result_reports_no_spend(self, dot_store: DotStore, transcript: Transcript) -> None:
        session = start_task(dot_store)
        self.spend(dot_store, session, 0.5)
        transcript.append(session, tool_result("c1"))
        ((kind, data),) = transcript.events()
        assert kind == "tool.called"
        assert "spent_usd" not in data


class TestTheEndOfAnApprovalsTelling:
    """The final answer of the turn that told a session of a decision ends that approval in its transaction."""

    def approval(self, store: DotStore, session_key: str, status: str) -> str:
        approval, _ = store.write(
            lambda c: s.request_approval(
                c, session_key=session_key, task_id=None, tool_call_id=f"call-{session_key}", tool="exec",
                permission="computer.exec", arguments={},
            )
        )
        decided, telling = {"granted": ("approved", "granted"), "told": ("rejected", "told")}[status]
        store.write(lambda c: s.advance_approval(c, approval.approval_id, "pending", decided))
        store.write(lambda c: s.advance_approval(c, approval.approval_id, decided, telling))
        return approval.approval_id

    def status(self, store: DotStore, approval_id: str) -> str:
        return store.read(lambda c: s.get_approval(c, approval_id)).status  # type: ignore[union-attr]

    @pytest.mark.parametrize("status", ["granted", "told"])
    def test_the_final_answer_of_the_chat_ends_it_with_the_answer(
        self, dot_store: DotStore, transcript: Transcript, status: str
    ) -> None:
        approval_id = self.approval(dot_store, s.CHAT_SESSION_KEY, status)
        transcript.append(s.CHAT_SESSION_KEY, final("understood"), final=True)
        assert self.status(dot_store, approval_id) == "done"
        assert transcript.events() == [("message.assistant", {"text": "understood", "spent_usd": 0.0})]

    def test_the_final_answer_of_a_task_ends_it_with_the_completion(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        session = start_task(dot_store)
        approval_id = self.approval(dot_store, session, "granted")
        transcript.append(session, final("all done"), final=True)
        assert self.status(dot_store, approval_id) == "done"
        assert [kind for kind, _ in transcript.events()] == ["task.completed"]

    def test_a_message_that_is_not_a_final_answer_leaves_it_and_so_does_another_session(
        self, dot_store: DotStore, transcript: Transcript
    ) -> None:
        approval_id = self.approval(dot_store, s.CHAT_SESSION_KEY, "granted")
        other = self.approval(dot_store, start_task(dot_store), "told")
        transcript.append(s.CHAT_SESSION_KEY, final("thinking aloud"))
        assert self.status(dot_store, approval_id) == "granted"
        transcript.append(s.CHAT_SESSION_KEY, final("the answer"), final=True)
        assert self.status(dot_store, approval_id) == "done"
        assert self.status(dot_store, other) == "told"
