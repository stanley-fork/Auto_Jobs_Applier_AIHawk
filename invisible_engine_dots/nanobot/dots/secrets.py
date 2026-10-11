"""Where `POST /secrets` puts the OpenRouter key and the MCP servers' secrets: the memory of this process.

invisible_dots architecture 4.3: a Dot keeps credentials in memory only. The
host pushes the key at every READY and every agent.started; the holder keeps
it for the provider to read and never logs it, writes it or puts it in an
environment.
"""

from __future__ import annotations

import re
from typing import Literal

from nanobot.dots.protocol import (
    MCP_SECRET_PATTERN,
    MCP_SECRET_RULE,
    MCP_SERVER_NAME_PATTERN,
    OPENROUTER_KEY_PATTERN,
    OPENROUTER_KEY_RULE,
)

KeyChange = Literal["received", "replaced", "unchanged"]

# What a key is made of is the host's rule (protocol.OPENROUTER_KEY_PATTERN, from packages/shared), which the
# host applies when the user enters the key; this is the guest's own check of what arrives. Anything else (a
# newline inside it, a control character, a non-ASCII letter) makes httpx or h11 refuse the request with an
# exception whose text is the whole header, `Illegal header value b'Bearer <key>'`, and the openai client
# chains it under its own "Connection error", where any log of the chain prints it.
_KEY_FORMAT = re.compile(OPENROUTER_KEY_PATTERN)


class KeyHolder:
    """The OpenRouter key, in memory."""

    __slots__ = ("_key",)

    def __init__(self) -> None:
        self._key: str | None = None

    @property
    def configured(self) -> bool:
        return self._key is not None

    def require(self) -> str:
        """The key, for the one place that builds a provider with it; raises when none was received.

        The key travels as an expression, never as a local variable of a long-lived
        caller: a traceback logged with variable values would print it.
        """
        if self._key is None:
            raise RuntimeError("the OpenRouter key has not been received")
        return self._key

    def set(self, key: str) -> KeyChange:
        """Hold `key`, and say whether it was received, replaced or is the one already held.

        The host pushes the same key at every READY and agent.started. The same
        key again changes nothing: rebuilding the provider for it would swap it
        under the turns already running.
        """
        if not key.strip():
            raise ValueError("the key is empty")
        if _KEY_FORMAT.fullmatch(key) is None:
            raise ValueError(OPENROUTER_KEY_RULE)
        previous = self._key
        if previous == key:
            return "unchanged"
        self._key = key
        return "received" if previous is None else "replaced"

    def __repr__(self) -> str:
        return f"KeyHolder(configured={self.configured})"


_MCP_SERVER_NAME = re.compile(MCP_SERVER_NAME_PATTERN)
_MCP_SECRET_FORMAT = re.compile(MCP_SECRET_PATTERN)


class McpSecrets:
    """The values of the secrets the config's MCP servers name, by server and name, in memory.

    The host pushes them with the OpenRouter key (`POST /secrets`, `mcp_secrets`). They leave this holder only for
    the server that names them: as environment variables of its process, through the relay's own environment and
    never its command line (computer.py), or as headers of its requests. They are masked in the conversation files.
    """

    __slots__ = ("_values",)

    def __init__(self) -> None:
        self._values: dict[str, dict[str, str]] = {}

    def set(self, values: object) -> bool:
        """Hold `values`, the whole set; whether it differs from what was held. A value is never in an error."""
        if not isinstance(values, dict):
            raise ValueError("mcp_secrets must be an object of servers")
        held: dict[str, dict[str, str]] = {}
        for server, secrets in values.items():
            if not isinstance(server, str) or _MCP_SERVER_NAME.fullmatch(server) is None:
                raise ValueError("mcp_secrets: a key is not an MCP server name")
            if not isinstance(secrets, dict):
                raise ValueError(f"mcp_secrets.{server} must be an object of secrets")
            for name, value in secrets.items():
                if not isinstance(name, str) or not name:
                    raise ValueError(f"mcp_secrets.{server}: a secret has no name")
                if not isinstance(value, str) or _MCP_SECRET_FORMAT.fullmatch(value) is None:
                    raise ValueError(f"mcp_secrets.{server}.{name}: {MCP_SECRET_RULE}")
            held[server] = dict(secrets)
        changed = held != self._values
        self._values = held
        return changed

    def of(self, server: str) -> dict[str, str]:
        """The secrets held for one server, by name (a copy)."""
        return dict(self._values.get(server, {}))

    def values(self) -> list[str]:
        """Every value held, for masking."""
        return [value for secrets in self._values.values() for value in secrets.values()]

    def __repr__(self) -> str:
        return f"McpSecrets(servers={sorted(self._values)})"
