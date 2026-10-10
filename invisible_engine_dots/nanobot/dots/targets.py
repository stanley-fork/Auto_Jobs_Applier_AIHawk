"""What of a tool call `tool.called` shows: one line naming the thing the call acted on.

The permission table (permissions.py) says, per tool, which function here picks that line from the call's
arguments; nothing else of the arguments travels in `tool.called`. A tool that is not in the table has no
target. Each function takes the arguments as the model sent them, trusts none of their types, and returns
None when there is nothing to name. `permissions.tool_target` cuts every target at `TOOL_TARGET_MAX`
characters (the host's schema refuses more).

The table also says which arguments an `approval.requested` carries: the arguments as they are, except that
the proxy of `browser_identity_create` is masked and the URL of `browser_navigate` has no user and password.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

_ELLIPSIS = "…"
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_URL = re.compile(r"(?i)([a-z][a-z0-9+.-]*://)([^/?#]*)(.*)", re.DOTALL)


def without_userinfo(text: str) -> str:
    """The URL without the user and the password of its authority, everything else as it is; text that is no URL as it is."""
    url = _URL.fullmatch(text)
    if url is None:
        return text
    scheme, authority, rest = url.groups()
    return scheme + authority.rpartition("@")[2] + rest


def clip(text: str, limit: int) -> str:
    """The text on one line, at most `limit` characters (code points, as the host's schema counts), cut with an ellipsis."""
    text = _CONTROL.sub(" ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + _ELLIPSIS


def _string(params: Mapping[str, Any], *names: str) -> str:
    """The first of the named arguments that is a non-blank string, stripped; "" when none is."""
    for name in names:
        value = params.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def exec_target(params: Mapping[str, Any]) -> str | None:
    """The command's first line."""
    command = _string(params, "command", "cmd")
    return command.splitlines()[0] if command else None


def exec_starts_terminal(params: Mapping[str, Any]) -> bool:
    """Whether the call asks `exec` for a terminal session (`tty`): a client shows "started a terminal session"."""
    return params.get("tty") is True


def never_starts_terminal(params: Mapping[str, Any]) -> bool:
    return False


def path_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "path") or None


def find_files_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "query", "glob", "path") or None


def grep_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "pattern") or None


def apply_patch_target(params: Mapping[str, Any]) -> str | None:
    edits = params.get("edits")
    paths = [
        edit["path"].strip()
        for edit in (edits if isinstance(edits, list) else [])
        if isinstance(edit, Mapping) and isinstance(edit.get("path"), str) and edit["path"].strip()
    ]
    if not paths:
        return None
    if len(paths) == 1:
        return paths[0]
    return f"{len(paths)} files, first {paths[0]}"


def cron_target(params: Mapping[str, Any]) -> str | None:
    action = _string(params, "action")
    if not action:
        return None
    return f"{action} {_string(params, 'name', 'job_id')}".strip()


def exec_session_target(params: Mapping[str, Any]) -> str | None:
    session_id = _string(params, "session_id")
    if not session_id:
        return None
    if params.get("terminate") is True:
        return f"terminate {session_id}"
    if params.get("input") is not None:
        return f"input to {session_id}"
    return f"output of {session_id}"


def no_target(params: Mapping[str, Any]) -> str | None:
    """For a tool that acts on nothing in particular (it lists)."""
    return None


def _on_identity(params: Mapping[str, Any], detail: str | None) -> str | None:
    """`<identity id>: <detail>`, or the id alone; None without an identity."""
    identity = _string(params, "identity_id")
    if not identity:
        return None
    return f"{identity}: {detail}" if detail else identity


def identity_name_target(params: Mapping[str, Any]) -> str | None:
    """`browser_identity_create`: the name the identity is given, never its proxy."""
    return _string(params, "name") or None


def identity_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "identity_id") or None


def browser_navigate_target(params: Mapping[str, Any]) -> str | None:
    url = _string(params, "url")
    return _on_identity(params, without_userinfo(url) if url else None)


def browser_selector_target(params: Mapping[str, Any]) -> str | None:
    """A selector names a place on a page; the text of `browser_type` or the value of a choice is left out."""
    return _on_identity(params, _string(params, "selector") or None)


def browser_click_at_target(params: Mapping[str, Any]) -> str | None:
    x, y = params.get("x"), params.get("y")
    if isinstance(x, int) and isinstance(y, int) and not isinstance(x, bool) and not isinstance(y, bool):
        return _on_identity(params, f"at {x},{y}")
    return _on_identity(params, None)


def browser_press_key_target(params: Mapping[str, Any]) -> str | None:
    return _on_identity(params, _string(params, "key") or None)


def browser_identity_only_target(params: Mapping[str, Any]) -> str | None:
    """A browser call with nothing to name but the identity it acted on."""
    return _on_identity(params, None)


def all_arguments(params: Mapping[str, Any]) -> dict[str, Any]:
    """The arguments of a call that carries nothing to hide: as they are."""
    return dict(params)


def navigate_arguments(params: Mapping[str, Any]) -> dict[str, Any]:
    """The arguments of `browser_navigate` with the URL's user and password left out; the rest as it is."""
    shown = dict(params)
    url = shown.get("url")
    if isinstance(url, str) and url.strip():
        shown["url"] = without_userinfo(url.strip())
    return shown


def identity_create_arguments(params: Mapping[str, Any]) -> dict[str, Any]:
    """The arguments of `browser_identity_create` with its proxy masked: an approval says that one is given, not which."""
    shown = dict(params)
    if isinstance(shown.get("proxy"), str) and shown["proxy"]:
        shown["proxy"] = "***"
    return shown
