from __future__ import annotations

import asyncio
import sys
from contextlib import asynccontextmanager
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fakes.run_tool import run_tool

import nanobot.agent.tools.mcp as mcp_mod
from nanobot.agent.tools.mcp import (
    MCPPromptWrapper,
    MCPProvider,
    MCPResourceWrapper,
    MCPServerConfig,
    MCPToolWrapper,
    _sanitize_mcp_tool_name,
    _sanitize_name,
    connect_mcp_servers,
)
from nanobot.agent.tools.registry import ToolRegistry, is_tool_error_result

_PROXY_ENV_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")


def test_type_checking_only_mcp_annotations_are_deferred() -> None:
    assert mcp_mod._MCPWrapperBase.__annotations__["_session"] == "ClientSession"
    assert MCPToolWrapper.__init__.__annotations__["session"] == "ClientSession"
    assert MCPResourceWrapper.__init__.__annotations__["resource_def"] == "Resource"
    assert MCPPromptWrapper.__init__.__annotations__["prompt_def"] == "Prompt"
    assert connect_mcp_servers.__annotations__["mcp_servers"] == "dict[str, MCPServerConfig]"


class _FakeTextContent:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeTextResourceContents:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeBlobResourceContents:
    def __init__(self, blob: bytes) -> None:
        self.blob = blob


class _FakeImageContent:
    def __init__(self, data: str, mime_type: str = "image/png") -> None:
        self.data = data
        self.mimeType = mime_type


@pytest.fixture
def fake_mcp_runtime() -> dict[str, object | None]:
    return {"session": None}


@pytest.fixture(autouse=True)
def _clear_proxy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (*_PROXY_ENV_VARS, "NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def _fake_mcp_module(
    monkeypatch: pytest.MonkeyPatch, fake_mcp_runtime: dict[str, object | None]
) -> None:
    mod = ModuleType("mcp")
    mod.types = SimpleNamespace(
        TextContent=_FakeTextContent,
        TextResourceContents=_FakeTextResourceContents,
        BlobResourceContents=_FakeBlobResourceContents,
        ImageContent=_FakeImageContent,
        PaginatedRequestParams=SimpleNamespace,
    )

    class _FakeStdioServerParameters:
        def __init__(
            self,
            command: str,
            args: list[str],
            env: dict | None = None,
            cwd: str | None = None,
        ) -> None:
            self.command = command
            self.args = args
            self.env = env
            self.cwd = cwd

    class _FakeClientSession:
        def __init__(self, _read: object, _write: object) -> None:
            self._session = fake_mcp_runtime["session"]

        async def __aenter__(self) -> object:
            return self._session

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

    @asynccontextmanager
    async def _fake_stdio_client(_params: object, errlog: object = None):
        yield object(), object()

    @asynccontextmanager
    async def _fake_sse_client(_url: str, httpx_client_factory=None):
        yield object(), object()

    @asynccontextmanager
    async def _fake_streamable_http_client(_url: str, http_client=None):
        yield object(), object(), object()

    mod.ClientSession = _FakeClientSession
    mod.StdioServerParameters = _FakeStdioServerParameters
    monkeypatch.setitem(sys.modules, "mcp", mod)

    client_mod = ModuleType("mcp.client")
    stdio_mod = ModuleType("mcp.client.stdio")
    stdio_mod.stdio_client = _fake_stdio_client
    sse_mod = ModuleType("mcp.client.sse")
    sse_mod.sse_client = _fake_sse_client
    streamable_http_mod = ModuleType("mcp.client.streamable_http")
    streamable_http_mod.streamable_http_client = _fake_streamable_http_client

    monkeypatch.setitem(sys.modules, "mcp.client", client_mod)
    monkeypatch.setitem(sys.modules, "mcp.client.stdio", stdio_mod)
    monkeypatch.setitem(sys.modules, "mcp.client.sse", sse_mod)
    monkeypatch.setitem(sys.modules, "mcp.client.streamable_http", streamable_http_mod)

    shared_mod = ModuleType("mcp.shared")
    exc_mod = ModuleType("mcp.shared.exceptions")

    class _FakeMcpError(Exception):
        def __init__(self, code: int = -1, message: str = "error"):
            self.error = SimpleNamespace(code=code, message=message)
            super().__init__(message)

    exc_mod.McpError = _FakeMcpError
    monkeypatch.setitem(sys.modules, "mcp.shared", shared_mod)
    monkeypatch.setitem(sys.modules, "mcp.shared.exceptions", exc_mod)


def _make_wrapper(session: object, *, timeout: float = 0.1) -> MCPToolWrapper:
    tool_def = SimpleNamespace(
        name="demo",
        description="demo tool",
        inputSchema={"type": "object", "properties": {}},
    )
    return MCPToolWrapper(session, "test", tool_def, tool_timeout=timeout)


@pytest.mark.asyncio
async def test_mcp_provider_connect_propagates_external_cancellation(monkeypatch) -> None:
    started = asyncio.Event()

    async def connect_mcp_servers(_servers: dict, _registry: ToolRegistry, _on_ended: object, **_sinks: object) -> dict:
        started.set()
        await asyncio.sleep(60)
        return {}

    provider = MCPProvider(
        {"test": MCPServerConfig(command="fake")},
        ToolRegistry(),
    )
    monkeypatch.setattr(mcp_mod, "connect_mcp_servers", connect_mcp_servers)

    task = asyncio.create_task(provider.connect())
    await asyncio.wait_for(started.wait(), timeout=1.0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert provider._connections == {}


@pytest.mark.parametrize( "value_schema, params, error",
    [
        pytest.param(
            True, {"value": {"count": "42", "enabled": False}}, None,
            id="true-property-preserves-value",
        ),
        pytest.param(
            False, {"value": None}, "value is not allowed by schema",
            id="false-property-rejects-null",
        ),
        pytest.param(False, {}, None, id="false-property-can-be-absent"),
        pytest.param(
            {"type": "array", "items": True},
            {"value": ["42", False, None, {"nested": [1]}]},
            None,
            id="true-items-preserve-values",
        ),
        pytest.param(
            {"type": "array", "items": False},
            {"value": [1]},
            "value[0] is not allowed by schema",
            id="false-items-reject-element",
        ),
        pytest.param(
            {"type": "array", "items": False}, {"value": []}, None,
            id="false-items-allow-empty-array",
        ),
        pytest.param(
            {"type": "object", "properties": {"blocked": False}},
            {"value": {"blocked": "x"}},
            "value.blocked is not allowed by schema",
            id="nested-false-property-reports-path",
        ),
    ],
)
async def test_registry_executes_mcp_tools_with_boolean_subschemas(
    value_schema, params, error,
) -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(return_value=SimpleNamespace(content=[_FakeTextContent("ok")])),
    )
    tool_def = SimpleNamespace(
        name="demo",
        description="demo tool",
        inputSchema={"type": "object", "properties": {"value": value_schema}},
    )
    wrapper = MCPToolWrapper(session, "test", tool_def)
    registry = ToolRegistry()
    registry.register(wrapper)

    result = await run_tool(registry, wrapper.name, params)

    if error is None:
        assert result == "ok"
        session.call_tool.assert_awaited_once_with("demo", arguments=params)
    else:
        assert is_tool_error_result(result)
        assert f"Invalid parameters for tool '{wrapper.name}': {error}" in result
        session.call_tool.assert_not_awaited()


@pytest.mark.parametrize("types", [["integer", "string"], ["string", "integer"]])
@pytest.mark.parametrize("value", ["00123", "doc-A", 42])
async def test_registry_preserves_mcp_type_union_arguments(types, value) -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(return_value=SimpleNamespace(content=[_FakeTextContent("ok")])),
    )
    tool_def = SimpleNamespace(
        name="lookup",
        description="Look up an id without changing its type or value.",
        inputSchema={
            "type": "object",
            "properties": {"id": {"type": types}},
            "required": ["id"],
        },
    )
    wrapper = MCPToolWrapper(session, "test", tool_def)
    registry = ToolRegistry()
    registry.register(wrapper)

    result = await run_tool(registry, wrapper.name, {"id": value})

    assert result == "ok"
    session.call_tool.assert_awaited_once_with("lookup", arguments={"id": value})
    assert type(session.call_tool.call_args.kwargs["arguments"]["id"]) is type(value)


def test_wrapper_preserves_non_nullable_unions() -> None:
    tool_def = SimpleNamespace(
        name="demo",
        description="demo tool",
        inputSchema={
            "type": "object",
            "properties": {
                "value": {
                    "anyOf": [{"type": "string"}, {"type": "integer"}],
                }
            },
        },
    )

    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "test", tool_def)

    assert wrapper.parameters["properties"]["value"]["anyOf"] == [
        {"type": "string"},
        {"type": "integer"},
    ]


def test_wrapper_normalizes_nullable_property_type_union() -> None:
    tool_def = SimpleNamespace(
        name="demo",
        description="demo tool",
        inputSchema={
            "type": "object",
            "properties": {
                "name": {"type": ["string", "null"]},
            },
        },
    )

    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "test", tool_def)

    assert wrapper.parameters["properties"]["name"] == {"type": "string", "nullable": True}


def test_wrapper_normalizes_nullable_property_anyof() -> None:
    tool_def = SimpleNamespace(
        name="demo",
        description="demo tool",
        inputSchema={
            "type": "object",
            "properties": {
                "name": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "description": "optional name",
                },
            },
        },
    )

    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "test", tool_def)

    assert wrapper.parameters["properties"]["name"] == {
        "type": "string",
        "description": "optional name",
        "nullable": True,
    }


def test_wrapper_hoists_recursive_local_refs_into_defs() -> None:
    recursive_items_ref = "#/properties/filter/properties/items"
    tool_def = SimpleNamespace(
        name="search_dataset",
        description="search tool",
        inputSchema={
            "type": "object",
            "properties": {
                "filter": {
                    "type": "object",
                    "properties": {
                        "items": {
                            "type": "array",
                            "items": {"$ref": recursive_items_ref},
                        }
                    },
                    "required": ["items"],
                }
            },
        },
    )

    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "test", tool_def)

    generated_ref = wrapper.parameters["properties"]["filter"]["properties"]["items"][
        "items"
    ]["$ref"]
    assert generated_ref.startswith("#/$defs/ref_")
    generated_name = generated_ref.removeprefix("#/$defs/")
    generated_schema = wrapper.parameters["$defs"][generated_name]
    assert generated_schema["type"] == "array"
    assert generated_schema["items"]["$ref"] == generated_ref


def test_wrapper_hoists_root_self_ref_into_defs() -> None:
    tool_def = SimpleNamespace(
        name="tree",
        description="tree tool",
        inputSchema={
            "type": "object",
            "properties": {
                "children": {"type": "array", "items": {"$ref": "#"}},
            },
        },
    )

    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "test", tool_def)

    generated_ref = wrapper.parameters["properties"]["children"]["items"]["$ref"]
    assert generated_ref.startswith("#/$defs/ref_")
    generated_name = generated_ref.removeprefix("#/$defs/")
    assert wrapper.parameters["$defs"][generated_name]["properties"]["children"]["items"] == {
        "$ref": generated_ref
    }


def test_wrapper_preserves_existing_defs_refs() -> None:
    tool_def = SimpleNamespace(
        name="demo",
        description="demo tool",
        inputSchema={
            "type": "object",
            "$defs": {"value": {"type": "string"}},
            "properties": {"value": {"$ref": "#/$defs/value"}},
        },
    )

    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "test", tool_def)

    assert wrapper.parameters["properties"]["value"]["$ref"] == "#/$defs/value"
    assert wrapper.parameters["$defs"]["value"]["type"] == "string"


def test_wrapper_resolves_uri_encoded_json_pointer() -> None:
    tool_def = SimpleNamespace(
        name="demo",
        description="demo tool",
        inputSchema={
            "type": "object",
            "properties": {
                "space name/value": {"type": "string"},
                "alias": {"$ref": "#/properties/space%20name~1value"},
            },
        },
    )

    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "test", tool_def)

    generated_ref = wrapper.parameters["properties"]["alias"]["$ref"]
    assert generated_ref.startswith("#/$defs/ref_")
    generated_name = generated_ref.removeprefix("#/$defs/")
    assert wrapper.parameters["$defs"][generated_name] == {"type": "string"}


@pytest.mark.asyncio
async def test_execute_returns_text_blocks() -> None:
    async def call_tool(_name: str, arguments: dict) -> object:
        assert arguments == {"value": 1}
        return SimpleNamespace(content=[_FakeTextContent("hello"), 42])

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))

    result = await wrapper.execute(value=1)

    assert result == "hello\n42"


@pytest.mark.asyncio
async def test_execute_wraps_mcp_is_error_result() -> None:
    async def call_tool(_name: str, arguments: dict) -> object:
        return SimpleNamespace(
            content=[_FakeTextContent("Error: server-side MCP failure")],
            isError=True,
        )

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))

    result = await wrapper.execute()

    assert result == "Error: server-side MCP failure"
    assert is_tool_error_result(result)


@pytest.mark.asyncio
async def test_execute_contains_malformed_success_result() -> None:
    async def call_tool(_name: str, arguments: dict) -> object:
        return SimpleNamespace(content=None)

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))

    result = await wrapper.execute()

    assert result == "(MCP tool returned malformed content: TypeError)"
    assert is_tool_error_result(result)


@pytest.mark.asyncio
async def test_registry_adds_retry_hint_to_malformed_mcp_result() -> None:
    async def call_tool(_name: str, arguments: dict) -> object:
        return SimpleNamespace(content=None)

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))
    registry = ToolRegistry()
    registry.register(wrapper)

    result = await run_tool(registry, wrapper.name, {})

    assert is_tool_error_result(result)
    assert "MCP tool returned malformed content" in result
    assert "Analyze the error above and try a different approach" in result


@pytest.mark.asyncio
async def test_execute_preserves_success_text_that_starts_with_error() -> None:
    async def call_tool(_name: str, arguments: dict) -> object:
        return SimpleNamespace(
            content=[_FakeTextContent("Error: generated report successfully")],
            isError=False,
        )

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))

    result = await wrapper.execute()

    assert result == "Error: generated report successfully"
    assert not is_tool_error_result(result)


@pytest.mark.asyncio
async def test_execute_reports_image_block_without_its_bytes() -> None:
    payload = "QUJD" * 64

    async def call_tool(_name: str, arguments: dict) -> object:
        return SimpleNamespace(
            content=[
                _FakeTextContent("here you go"),
                _FakeImageContent(payload, "image/png"),
            ]
        )

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))

    result = await wrapper.execute()

    assert result == (
        "here you go\n(MCP tool returned an image (image/png); images are not supported)"
    )
    # The base64 payload must never reach the model-facing result.
    assert payload not in result


@pytest.mark.asyncio
async def test_execute_reports_embedded_image_blob_by_mime_type() -> None:
    class _EmbeddedResource:
        def __init__(self, resource: object) -> None:
            self.resource = resource

    class _Blob(_FakeBlobResourceContents):
        def __init__(self, blob: bytes, mime_type: str) -> None:
            super().__init__(blob)
            self.mimeType = mime_type

    async def call_tool(_name: str, arguments: dict) -> object:
        return SimpleNamespace(content=[_EmbeddedResource(_Blob(b"ABC", "image/webp"))])

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))
    sys.modules["mcp"].types.EmbeddedResource = _EmbeddedResource
    sys.modules["mcp"].types.BlobResourceContents = _Blob

    result = await wrapper.execute()

    assert result == "(MCP tool returned an image (image/webp); images are not supported)"


@pytest.mark.asyncio
async def test_execute_returns_timeout_message() -> None:
    async def call_tool(_name: str, arguments: dict) -> object:
        await asyncio.sleep(1)
        return SimpleNamespace(content=[])

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool), timeout=0.01)

    result = await wrapper.execute()

    assert result == "(MCP tool call timed out after 0.01s)"
    assert is_tool_error_result(result)


@pytest.mark.asyncio
async def test_execute_handles_server_cancelled_error() -> None:
    async def call_tool(_name: str, arguments: dict) -> object:
        raise asyncio.CancelledError()

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))

    result = await wrapper.execute()

    assert result == "(MCP tool call was cancelled)"
    assert is_tool_error_result(result)


@pytest.mark.asyncio
async def test_execute_re_raises_external_cancellation() -> None:
    started = asyncio.Event()

    async def call_tool(_name: str, arguments: dict) -> object:
        started.set()
        await asyncio.sleep(60)
        return SimpleNamespace(content=[])

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool), timeout=10)
    task = asyncio.create_task(wrapper.execute())
    await asyncio.wait_for(started.wait(), timeout=1.0)

    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_execute_handles_generic_exception() -> None:
    async def call_tool(_name: str, arguments: dict) -> object:
        raise RuntimeError("boom")

    wrapper = _make_wrapper(SimpleNamespace(call_tool=call_tool))

    result = await wrapper.execute()

    assert result == "(MCP tool call failed: RuntimeError)"
    assert is_tool_error_result(result)


def _make_tool_def(name: str) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        description=f"{name} tool",
        inputSchema={"type": "object", "properties": {}},
    )


def _make_fake_session(tool_names: list[str]) -> SimpleNamespace:
    async def initialize() -> None:
        return None

    async def list_tools() -> SimpleNamespace:
        return SimpleNamespace(tools=[_make_tool_def(name) for name in tool_names], nextCursor=None)

    return SimpleNamespace(initialize=initialize, list_tools=list_tools)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("enabled_tools", "expected_names"),
    [
        pytest.param(["*"], ["first", "second"], id="wildcard"),
        pytest.param(["second"], ["second"], id="raw-allowlist"),
        pytest.param(["mcp_test_second"], ["second"], id="wrapped-allowlist"),
        pytest.param([], [], id="deny-all"),
    ],
)
async def test_connect_mcp_servers_loads_all_tool_pages(
    fake_mcp_runtime: dict[str, object | None],
    enabled_tools: list[str],
    expected_names: list[str],
) -> None:
    cursors: list[str | None] = []
    pages = {
        None: SimpleNamespace(tools=[_make_tool_def("first")], nextCursor=""),
        "": SimpleNamespace(tools=[], nextCursor="opaque:+/="),
        "opaque:+/=": SimpleNamespace(tools=[_make_tool_def("second")], nextCursor=None),
    }

    async def list_tools(*, params: SimpleNamespace | None = None) -> SimpleNamespace:
        cursor = params.cursor if params is not None else None
        cursors.append(cursor)
        return pages[cursor]

    session = _make_fake_session([])
    session.list_tools = list_tools
    session.call_tool = AsyncMock(
        return_value=SimpleNamespace(content=[_FakeTextContent("second page result")])
    )
    fake_mcp_runtime["session"] = session
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=enabled_tools)}, registry,
    )
    try:
        assert set(stacks) == {"test"}
        assert cursors == [None, "", "opaque:+/="]
        expected = [f"mcp_test_{name}" for name in expected_names]
        assert registry.tool_names == expected
        assert [tool["function"]["name"] for tool in registry.get_definitions()] == expected
        if expected_names:
            assert await run_tool(registry, "mcp_test_second", {}) == "second page result"
            session.call_tool.assert_awaited_once_with("second", arguments={})
        else:
            session.call_tool.assert_not_awaited()
    finally:
        for stack in stacks.values():
            await stack.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["request-error", "repeated-cursor"])
async def test_connect_mcp_servers_pagination_failure_registers_no_tools(
    fake_mcp_runtime: dict[str, object | None], failure: str,
) -> None:
    cursors: list[str | None] = []

    async def list_tools(*, params: SimpleNamespace | None = None) -> SimpleNamespace:
        cursor = params.cursor if params is not None else None
        cursors.append(cursor)
        if cursor is None:
            return SimpleNamespace(tools=[_make_tool_def("first")], nextCursor="next")
        if failure == "request-error":
            raise RuntimeError("second page failed")
        if len(cursors) > 2:
            raise AssertionError("A repeated cursor must not be requested again")
        return SimpleNamespace(tools=[_make_tool_def("second")], nextCursor="next")

    session = _make_fake_session([])
    session.list_tools = list_tools
    fake_mcp_runtime["session"] = session
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake")}, registry,
    )
    try:
        assert cursors == [None, "next"]
        assert stacks == {}
        assert registry.tool_names == []
        assert registry.get_definitions() == []
    finally:
        for stack in stacks.values():
            await stack.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "enabled_tool",
    [
        pytest.param("demo", id="raw_names"),
        pytest.param("mcp_test_demo", id="wrapped_names"),
    ],
)
async def test_connect_mcp_servers_enabled_tools_accepts_raw_and_wrapped_names(
    fake_mcp_runtime: dict[str,
    object | None],
    enabled_tool,
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo", "other"])
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=[enabled_tool])},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert registry.tool_names == ["mcp_test_demo"]


@pytest.mark.asyncio
async def test_connect_mcp_servers_enabled_tools_defaults_to_all(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo", "other"])
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake")},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert registry.tool_names == ["mcp_test_demo", "mcp_test_other"]


@pytest.mark.asyncio
async def test_connect_mcp_servers_enabled_tools_supports_limited_wrapped_names(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    long_tool_name = "tool-" + "very-long-name-" * 8
    wrapped_name = _sanitize_mcp_tool_name(f"mcp_test_{long_tool_name}")
    assert len(wrapped_name) == 64

    fake_mcp_runtime["session"] = _make_fake_session([long_tool_name, "other"])
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=[wrapped_name])},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert registry.tool_names == [wrapped_name]


@pytest.mark.asyncio
async def test_connect_mcp_servers_enabled_tools_empty_list_registers_none(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo", "other"])
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=[])},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert registry.tool_names == []


@pytest.mark.asyncio
async def test_connect_mcp_servers_enabled_tools_empty_list_blocks_resources_and_prompts(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    """enabledTools: [] (deny-all) must also block resource and prompt registration."""
    fake_mcp_runtime["session"] = _make_fake_session_with_capabilities(
        tool_names=["demo"],
        resource_names=["secret_data"],
        prompt_names=["admin_prompt"],
    )
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=[])},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert registry.tool_names == []
    # Resources and prompts must also be blocked
    assert not any("secret_data" in name for name in registry.tool_names)
    assert not any("admin_prompt" in name for name in registry.tool_names)


@pytest.mark.asyncio
async def test_connect_mcp_servers_enabled_tools_specific_list_blocks_resources_and_prompts(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    """enabledTools with specific tool names must not leak resources or prompts."""
    fake_mcp_runtime["session"] = _make_fake_session_with_capabilities(
        tool_names=["demo", "other"],
        resource_names=["secret_data"],
        prompt_names=["admin_prompt"],
    )
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=["demo"])},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    # Only the allowed tool should be registered
    assert "mcp_test_demo" in registry.tool_names
    assert "mcp_test_other" not in registry.tool_names
    # Resources and prompts must not leak
    assert not any("secret_data" in name for name in registry.tool_names)
    assert not any("admin_prompt" in name for name in registry.tool_names)


@pytest.mark.asyncio
async def test_connect_mcp_servers_enabled_tools_wildcard_allows_resources_and_prompts(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    """enabledTools: ['*'] should allow all tools, resources, and prompts."""
    fake_mcp_runtime["session"] = _make_fake_session_with_capabilities(
        tool_names=["demo"],
        resource_names=["public_data"],
        prompt_names=["help_prompt"],
    )
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=["*"])},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert "mcp_test_demo" in registry.tool_names
    assert any("public_data" in name for name in registry.tool_names)
    assert any("help_prompt" in name for name in registry.tool_names)


@pytest.mark.asyncio
async def test_connect_mcp_servers_enabled_tools_warns_on_unknown_entries(
    fake_mcp_runtime: dict[str, object | None], monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo"])
    registry = ToolRegistry()
    warnings: list[str] = []

    def _warning(message: str, *args: object) -> None:
        warnings.append(message.format(*args))

    monkeypatch.setattr("nanobot.agent.tools.mcp.logger.warning", _warning)

    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=["unknown"])},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert registry.tool_names == []
    assert warnings
    assert "enabledTools entries not found: unknown" in warnings[-1]
    assert "Available raw names: demo" in warnings[-1]
    assert "Available wrapped names: mcp_test_demo" in warnings[-1]


@pytest.mark.asyncio
async def test_connect_mcp_servers_logs_stdio_pollution_hint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    messages: list[str] = []

    @asynccontextmanager
    async def _broken_stdio_client(_params: object, errlog: object = None):
        raise RuntimeError("Parse error: Unexpected token 'INFO' before JSON-RPC headers")
        yield  # pragma: no cover

    monkeypatch.setattr(sys.modules["mcp.client.stdio"], "stdio_client", _broken_stdio_client)
    sink = mcp_mod.logger.add(
        lambda message: messages.append(message.record["message"]), level="ERROR"
    )

    registry = ToolRegistry()
    try:
        stacks = await connect_mcp_servers(
            {"gh": MCPServerConfig(command="github-mcp")}, registry
        )
    finally:
        mcp_mod.logger.remove(sink)

    assert stacks == {}
    assert messages
    assert "stdio protocol pollution" in messages[-1]
    assert "stdout" in messages[-1]
    assert "stderr" in messages[-1]


def test_transient_connection_group_logs_brief_warning_and_debug_trace() -> None:
    records: list[dict] = []
    sink = mcp_mod.logger.add(lambda message: records.append(message.record), level="DEBUG")
    error = ExceptionGroup("transport failed", [httpx.ConnectError("")])
    try:
        mcp_mod._log_mcp_connection_failure("notion", error)
    finally:
        mcp_mod.logger.remove(sink)

    warning = next(record for record in records if record["level"].name == "WARNING")
    debug = next(record for record in records if record["level"].name == "DEBUG")
    assert warning["exception"] is None
    assert "transient connection failure" in warning["message"]
    assert debug["exception"] is not None
    assert not any(record["level"].name == "ERROR" for record in records)


def test_unexpected_connection_failure_keeps_error_trace() -> None:
    records: list[dict] = []
    sink = mcp_mod.logger.add(lambda message: records.append(message.record), level="DEBUG")
    try:
        mcp_mod._log_mcp_connection_failure("notion", RuntimeError("boom"))
    finally:
        mcp_mod.logger.remove(sink)

    error = next(record for record in records if record["level"].name == "ERROR")
    assert error["exception"] is not None
    assert not any(record["level"].name == "WARNING" for record in records)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["exception", "cancellation"])
async def test_connect_mcp_servers_one_failure_does_not_block_others(
    monkeypatch: pytest.MonkeyPatch,
    failure_mode: str,
) -> None:
    bad_session = _make_fake_session([])

    async def _cancel_initialize() -> None:
        raise asyncio.CancelledError("cancelled by SDK")

    if failure_mode == "cancellation":
        bad_session.initialize = _cancel_initialize
    sessions = {
        "bad": bad_session,
        "good": _make_fake_session(["demo"]),
    }

    class _SelectiveClientSession:
        def __init__(self, read: object, _write: object) -> None:
            self._session = sessions[read]

        async def __aenter__(self) -> object:
            return self._session

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

    @asynccontextmanager
    async def _selective_stdio_client(params: object, errlog: object = None):
        if params.command == "bad" and failure_mode == "exception":
            raise RuntimeError("boom")
        yield params.command, object()

    monkeypatch.setattr(sys.modules["mcp"], "ClientSession", _SelectiveClientSession)
    monkeypatch.setattr(sys.modules["mcp.client.stdio"], "stdio_client", _selective_stdio_client)

    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {
            "bad": MCPServerConfig(command="bad"),
            "good": MCPServerConfig(command="good"),
        },
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert registry.tool_names == ["mcp_good_demo"]
    assert set(stacks) == {"good"}


@pytest.mark.asyncio
async def test_connect_mcp_servers_propagates_external_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = asyncio.Event()
    closed = asyncio.Event()

    @asynccontextmanager
    async def _blocking_stdio_client(_params: object, errlog: object = None):
        try:
            started.set()
            await asyncio.Event().wait()
            yield object(), object()
        finally:
            closed.set()

    monkeypatch.setattr(sys.modules["mcp.client.stdio"], "stdio_client", _blocking_stdio_client)

    task = asyncio.create_task(
        connect_mcp_servers({"slow": MCPServerConfig(command="slow")}, ToolRegistry())
    )
    await asyncio.wait_for(started.wait(), timeout=1.0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    await asyncio.wait_for(closed.wait(), timeout=1.0)


@pytest.mark.asyncio
async def test_connect_mcp_servers_rolls_back_completed_batch_on_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    slow_started = asyncio.Event()
    closed: list[str] = []
    sessions = {"fast": _make_fake_session(["demo"])}

    class _SelectiveClientSession:
        def __init__(self, read: object, _write: object) -> None:
            self._session = sessions[str(read)]

        async def __aenter__(self) -> object:
            return self._session

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

    @asynccontextmanager
    async def _selective_stdio_client(params: object, errlog: object = None):
        command = str(params.command)
        try:
            if command == "slow":
                slow_started.set()
                await asyncio.Event().wait()
            yield command, object()
        finally:
            closed.append(command)

    monkeypatch.setattr(sys.modules["mcp"], "ClientSession", _SelectiveClientSession)
    monkeypatch.setattr(sys.modules["mcp.client.stdio"], "stdio_client", _selective_stdio_client)

    registry = ToolRegistry()
    task = asyncio.create_task(
        connect_mcp_servers(
            {
                "fast": MCPServerConfig(command="fast"),
                "slow": MCPServerConfig(command="slow"),
            },
            registry,
        )
    )
    await asyncio.wait_for(slow_started.wait(), timeout=1.0)
    assert registry.tool_names == ["mcp_fast_demo"]

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert registry.tool_names == []
    assert sorted(closed) == ["fast", "slow"]


@pytest.mark.asyncio
async def test_connect_mcp_servers_streamable_http_uses_finite_timeout(
    fake_mcp_runtime: dict[str, object | None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo"])
    captured: dict[str, object] = {}

    async def _reachable(_url: str) -> bool:
        return True

    @asynccontextmanager
    async def _capturing_streamable_http_client(_url: str, http_client=None):
        captured["timeout"] = http_client.timeout
        yield object(), object(), object()

    monkeypatch.setattr(mcp_mod, "_probe_http_url", _reachable)
    monkeypatch.setattr(
        sys.modules["mcp.client.streamable_http"],
        "streamable_http_client",
        _capturing_streamable_http_client,
    )

    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(url="https://mcp.example.com/mcp")},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    timeout = captured["timeout"]
    assert timeout.connect == 10.0
    assert timeout.read == 30.0
    assert timeout.write == 30.0
    assert timeout.pool == 30.0


@pytest.mark.parametrize("transport", ["sse", "streamableHttp"])
@pytest.mark.asyncio
async def test_connect_mcp_servers_builds_the_http_client_of_a_remote_server(
    transport: str,
    fake_mcp_runtime: dict[str, object | None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo"])
    captured: dict[str, object] = {}

    async def _reachable(_url: str) -> bool:
        return True

    class FakeAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            captured["client_kwargs"] = kwargs

        async def __aenter__(self) -> object:
            return self

        async def __aexit__(self, exc_type: object, exc: object, tb: object) -> bool:
            return False

    @asynccontextmanager
    async def _capturing_sse_client(_url: str, **kwargs: object):
        captured["sse_kwargs"] = kwargs
        factory = kwargs["httpx_client_factory"]
        factory()
        yield object(), object()

    @asynccontextmanager
    async def _capturing_streamable_http_client(_url: str, http_client=None):
        assert http_client is not None
        yield object(), object(), object()

    monkeypatch.setattr(mcp_mod, "_probe_http_url", _reachable)
    monkeypatch.setattr(mcp_mod.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(sys.modules["mcp.client.sse"], "sse_client", _capturing_sse_client)
    monkeypatch.setattr(
        sys.modules["mcp.client.streamable_http"],
        "streamable_http_client",
        _capturing_streamable_http_client,
    )

    url = "https://mcp.example.com/sse" if transport == "sse" else "https://mcp.example.com/mcp"
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"remote": MCPServerConfig(type=transport, url=url)},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    client_kwargs = captured["client_kwargs"]
    assert isinstance(client_kwargs, dict)
    assert client_kwargs.get("auth") is None
    if transport == "sse":
        assert set(captured["sse_kwargs"]) == {"httpx_client_factory"}


@pytest.mark.asyncio
async def test_connect_mcp_servers_passes_stdio_cwd(
    fake_mcp_runtime: dict[str, object | None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo"])
    captured: dict[str, object] = {}

    @asynccontextmanager
    async def _capturing_stdio_client(params: object, errlog: object = None):
        captured["cwd"] = params.cwd
        yield object(), object()

    monkeypatch.setattr(sys.modules["mcp.client.stdio"], "stdio_client", _capturing_stdio_client)

    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", cwd="/tmp/nanobot-mcp-test")},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert captured["cwd"] == "/tmp/nanobot-mcp-test"


# ---------------------------------------------------------------------------
# MCPResourceWrapper tests
# ---------------------------------------------------------------------------


def _make_resource_def(
    name: str = "myres",
    uri: str = "file:///tmp/data.txt",
    description: str = "A test resource",
) -> SimpleNamespace:
    return SimpleNamespace(name=name, uri=uri, description=description)


def _make_resource_wrapper(session: object, *, timeout: float = 0.1) -> MCPResourceWrapper:
    return MCPResourceWrapper(session, "srv", _make_resource_def(), resource_timeout=timeout)


def test_resource_wrapper_properties() -> None:
    wrapper = MCPResourceWrapper(None, "myserver", _make_resource_def())
    assert wrapper.name == "mcp_myserver_resource_myres"
    assert "[MCP Resource]" in wrapper.description
    assert "A test resource" in wrapper.description
    assert "file:///tmp/data.txt" in wrapper.description
    assert wrapper.parameters == {"type": "object", "properties": {}, "required": []}
    assert wrapper.read_only is True


@pytest.mark.asyncio
async def test_resource_wrapper_execute_returns_text() -> None:
    async def read_resource(uri: str) -> object:
        assert uri == "file:///tmp/data.txt"
        return SimpleNamespace(
            contents=[_FakeTextResourceContents("line1"), _FakeTextResourceContents("line2")]
        )

    wrapper = _make_resource_wrapper(SimpleNamespace(read_resource=read_resource))
    result = await wrapper.execute()
    assert result == "line1\nline2"


@pytest.mark.asyncio
async def test_resource_wrapper_execute_handles_blob() -> None:
    async def read_resource(uri: str) -> object:
        return SimpleNamespace(contents=[_FakeBlobResourceContents(b"\x00\x01\x02")])

    wrapper = _make_resource_wrapper(SimpleNamespace(read_resource=read_resource))
    result = await wrapper.execute()
    assert "[Binary resource: 3 bytes]" in result


@pytest.mark.asyncio
async def test_resource_wrapper_execute_handles_timeout() -> None:
    async def read_resource(uri: str) -> object:
        await asyncio.sleep(1)
        return SimpleNamespace(contents=[])

    wrapper = _make_resource_wrapper(SimpleNamespace(read_resource=read_resource), timeout=0.01)
    result = await wrapper.execute()
    assert result == "(MCP resource read timed out after 0.01s)"


@pytest.mark.asyncio
async def test_resource_wrapper_execute_handles_error() -> None:
    async def read_resource(uri: str) -> object:
        raise RuntimeError("boom")

    wrapper = _make_resource_wrapper(SimpleNamespace(read_resource=read_resource))
    result = await wrapper.execute()
    assert result == "(MCP resource read failed: RuntimeError)"


# ---------------------------------------------------------------------------
# MCPPromptWrapper tests
# ---------------------------------------------------------------------------


def _make_prompt_def(
    name: str = "myprompt",
    description: str = "A test prompt",
    arguments: list | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(name=name, description=description, arguments=arguments)


def _make_prompt_wrapper(session: object, *, timeout: float = 0.1) -> MCPPromptWrapper:
    return MCPPromptWrapper(session, "srv", _make_prompt_def(), prompt_timeout=timeout)


def test_prompt_wrapper_properties() -> None:
    arg1 = SimpleNamespace(name="topic", required=True)
    arg2 = SimpleNamespace(name="style", required=False)
    wrapper = MCPPromptWrapper(None, "myserver", _make_prompt_def(arguments=[arg1, arg2]))
    assert wrapper.name == "mcp_myserver_prompt_myprompt"
    assert "[MCP Prompt]" in wrapper.description
    assert "A test prompt" in wrapper.description
    assert "workflow guide" in wrapper.description
    assert wrapper.parameters["properties"]["topic"] == {"type": "string"}
    assert wrapper.parameters["properties"]["style"] == {"type": "string"}
    assert wrapper.parameters["required"] == ["topic"]
    assert wrapper.read_only is True


def test_prompt_wrapper_no_arguments() -> None:
    wrapper = MCPPromptWrapper(None, "myserver", _make_prompt_def())
    assert wrapper.parameters == {"type": "object", "properties": {}, "required": []}


def test_prompt_wrapper_preserves_argument_descriptions() -> None:
    arg = SimpleNamespace(name="topic", required=True, description="The subject to discuss")
    wrapper = MCPPromptWrapper(None, "srv", _make_prompt_def(arguments=[arg]))
    assert wrapper.parameters["properties"]["topic"] == {
        "type": "string",
        "description": "The subject to discuss",
    }


@pytest.mark.asyncio
async def test_prompt_wrapper_execute_returns_text() -> None:
    async def get_prompt(name: str, arguments: dict | None = None) -> object:
        assert name == "myprompt"
        msg1 = SimpleNamespace(
            role="user",
            content=[_FakeTextContent("You are an expert on {{topic}}.")],
        )
        msg2 = SimpleNamespace(
            role="assistant",
            content=[_FakeTextContent("Understood. Ask me anything.")],
        )
        return SimpleNamespace(messages=[msg1, msg2])

    wrapper = _make_prompt_wrapper(SimpleNamespace(get_prompt=get_prompt))
    result = await wrapper.execute(topic="AI")
    assert "You are an expert on {{topic}}." in result
    assert "Understood. Ask me anything." in result


@pytest.mark.asyncio
async def test_prompt_wrapper_execute_handles_timeout() -> None:
    async def get_prompt(name: str, arguments: dict | None = None) -> object:
        await asyncio.sleep(1)
        return SimpleNamespace(messages=[])

    wrapper = _make_prompt_wrapper(SimpleNamespace(get_prompt=get_prompt), timeout=0.01)
    result = await wrapper.execute()
    assert result == "(MCP prompt call timed out after 0.01s)"


@pytest.mark.asyncio
async def test_prompt_wrapper_execute_handles_mcp_error() -> None:
    from mcp.shared.exceptions import McpError

    async def get_prompt(name: str, arguments: dict | None = None) -> object:
        raise McpError(code=42, message="invalid argument")

    wrapper = _make_prompt_wrapper(SimpleNamespace(get_prompt=get_prompt))
    result = await wrapper.execute()
    assert "invalid argument" in result
    assert "code 42" in result


@pytest.mark.asyncio
async def test_prompt_wrapper_execute_handles_error() -> None:
    async def get_prompt(name: str, arguments: dict | None = None) -> object:
        raise RuntimeError("boom")

    wrapper = _make_prompt_wrapper(SimpleNamespace(get_prompt=get_prompt))
    result = await wrapper.execute()
    assert result == "(MCP prompt call failed: RuntimeError)"


# ---------------------------------------------------------------------------
# connect_mcp_servers: resources + prompts integration
# ---------------------------------------------------------------------------


def _make_fake_session_with_capabilities(
    tool_names: list[str],
    resource_names: list[str] | None = None,
    prompt_names: list[str] | None = None,
) -> SimpleNamespace:
    async def initialize() -> None:
        return None

    async def list_tools() -> SimpleNamespace:
        return SimpleNamespace(tools=[_make_tool_def(name) for name in tool_names], nextCursor=None)

    async def list_resources() -> SimpleNamespace:
        resources = []
        for rname in resource_names or []:
            resources.append(
                SimpleNamespace(
                    name=rname,
                    uri=f"file:///{rname}",
                    description=f"{rname} resource",
                )
            )
        return SimpleNamespace(resources=resources)

    async def list_prompts() -> SimpleNamespace:
        prompts = []
        for pname in prompt_names or []:
            prompts.append(
                SimpleNamespace(
                    name=pname,
                    description=f"{pname} prompt",
                    arguments=None,
                )
            )
        return SimpleNamespace(prompts=prompts)

    return SimpleNamespace(
        initialize=initialize,
        list_tools=list_tools,
        list_resources=list_resources,
        list_prompts=list_prompts,
    )


@pytest.mark.asyncio
async def test_connect_registers_resources_and_prompts(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session_with_capabilities(
        tool_names=["tool_a"],
        resource_names=["res_b"],
        prompt_names=["prompt_c"],
    )
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake")},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert "mcp_test_tool_a" in registry.tool_names
    assert "mcp_test_resource_res_b" in registry.tool_names
    assert "mcp_test_prompt_prompt_c" in registry.tool_names


# ---------------------------------------------------------------------------
# _sanitize_name tests
# ---------------------------------------------------------------------------


def test_sanitize_name_replaces_spaces() -> None:
    assert _sanitize_name("PostgreSQL System Information") == "PostgreSQL_System_Information"


def test_sanitize_name_replaces_special_characters() -> None:
    assert _sanitize_name("foo.bar@baz!") == "foo_bar_baz_"


def test_sanitize_name_collapses_consecutive_underscores() -> None:
    assert _sanitize_name("a   b") == "a_b"


def test_sanitize_name_preserves_valid_characters() -> None:
    assert _sanitize_name("my-tool_v2") == "my-tool_v2"


def test_sanitize_name_noop_for_already_clean_names() -> None:
    assert _sanitize_name("mcp_server_tool") == "mcp_server_tool"


# ---------------------------------------------------------------------------
# Wrapper sanitization tests
# ---------------------------------------------------------------------------


def test_tool_wrapper_sanitizes_name() -> None:
    tool_def = SimpleNamespace(
        name="My Tool",
        description="tool with spaces",
        inputSchema={"type": "object", "properties": {}},
    )
    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "srv", tool_def)
    assert wrapper.name == "mcp_srv_My_Tool"


def test_resource_wrapper_sanitizes_name() -> None:
    resource_def = SimpleNamespace(
        name="PostgreSQL System Information",
        uri="file:///pg/info",
        description="PG info",
    )
    wrapper = MCPResourceWrapper(None, "srv", resource_def)
    assert wrapper.name == "mcp_srv_resource_PostgreSQL_System_Information"


def test_prompt_wrapper_sanitizes_name() -> None:
    prompt_def = SimpleNamespace(
        name="design-schema",
        description="Design schema",
        arguments=None,
    )
    # Hyphens are allowed, so this should pass through unchanged
    wrapper = MCPPromptWrapper(None, "my server", prompt_def)
    assert wrapper.name == "mcp_my_server_prompt_design-schema"


def test_tool_wrapper_preserves_original_name_for_mcp_call() -> None:
    tool_def = SimpleNamespace(
        name="My Tool",
        description="tool with spaces",
        inputSchema={"type": "object", "properties": {}},
    )
    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "srv", tool_def)
    # The sanitized API-facing name differs from the original MCP name
    assert wrapper.name == "mcp_srv_My_Tool"
    assert wrapper._original_name == "My Tool"


@pytest.mark.asyncio
async def test_connect_mcp_servers_sanitizes_resource_names(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session_with_capabilities(
        tool_names=[],
        resource_names=["PostgreSQL System Information"],
        prompt_names=[],
    )
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake")},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert "mcp_test_resource_PostgreSQL_System_Information" in registry.tool_names


@pytest.mark.asyncio
async def test_connect_mcp_servers_enabled_tools_matches_sanitized_name(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session_with_capabilities(
        tool_names=["My Tool", "other"],
    )
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {"test": MCPServerConfig(command="fake", enabled_tools=["mcp_test_My_Tool"])},
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    assert registry.tool_names == ["mcp_test_My_Tool"]


@pytest.mark.parametrize(
    "url, expected",
    [
        ("https://user:secret@host.example/sse", "https://host.example/..."),
        ("https://host.example:8443/mcp?token=abc#frag", "https://host.example:8443/..."),
        ("https://user:secret@[::1]:8443/sse?token=abc", "https://[::1]:8443/..."),
        ("https://host.example/sse", "https://host.example/..."),
        ("https://host.example", "https://host.example"),
        ("https://host.example/", "https://host.example/"),
    ],
)
def test_redact_url_strips_credentials_and_query(url: str, expected: str) -> None:
    assert mcp_mod._redact_url(url) == expected

def test_mcp_tool_name_keeps_short_name():
    name = _sanitize_mcp_tool_name("mcp_myserver_resource_myres")
    assert name == "mcp_myserver_resource_myres"


def test_mcp_tool_name_limits_long_name():
    long_name = "mcp_" + "a" * 100
    name = _sanitize_mcp_tool_name(long_name)

    assert len(name) <= 64
    assert name.startswith("mcp_")


def test_long_server_name_tools_are_matched_by_server_name() -> None:
    server_name = "very-long-server-name-" * 4
    tool_def = SimpleNamespace(
        name="search",
        description="search tool",
        inputSchema={"type": "object", "properties": {}},
    )
    other_tool_def = SimpleNamespace(
        name="search",
        description="other search tool",
        inputSchema={"type": "object", "properties": {}},
    )
    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), server_name, tool_def)
    other_wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "other", other_tool_def)
    registry = ToolRegistry()
    registry.register(wrapper)
    registry.register(other_wrapper)

    assert len(wrapper.name) == 64
    assert not wrapper.name.startswith(mcp_mod._tool_prefix(server_name))

    provider = MCPProvider(
        {server_name: MCPServerConfig(command="fake")},
        registry,
    )
    provider._attach_reconnect_handlers({server_name})
    assert wrapper._reconnect is not None
    assert other_wrapper._reconnect is None

    removed = mcp_mod._unregister_server_tools(registry, server_name)

    assert removed == 1
    assert wrapper.name not in registry.tool_names
    assert other_wrapper.name in registry.tool_names


async def test_a_provider_with_on_terminated_reports_a_dead_session_and_does_not_reconnect() -> None:
    from mcp.shared.exceptions import McpError

    session = SimpleNamespace(call_tool=AsyncMock(side_effect=McpError(message="Connection closed")))
    wrapper = MCPToolWrapper(
        session,
        "srv",
        SimpleNamespace(name="act", description="act", inputSchema={"type": "object", "properties": {}}),
    )
    registry = ToolRegistry()
    registry.register(wrapper)
    ended: list[str] = []
    provider = MCPProvider({"srv": MCPServerConfig(command="fake")}, registry, on_terminated=ended.append)
    provider._attach_reconnect_handlers({"srv"})
    reconnects = AsyncMock()
    provider._refresh_terminated_server = reconnects  # type: ignore[method-assign]

    result = await wrapper.execute()

    assert ended == ["srv"]
    reconnects.assert_not_awaited()
    session.call_tool.assert_awaited_once()
    assert is_tool_error_result(result)
    assert result.startswith("(MCP tool call failed: ")


class _ReadStream:
    """The read side of a transport: yields what it was given, then ends like a process that exited."""

    def __init__(self, *messages: object) -> None:
        self._messages = list(messages)

    async def __aenter__(self) -> "_ReadStream":
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def __aiter__(self) -> "_ReadStream":
        return self

    async def __anext__(self) -> object:
        if not self._messages:
            raise StopAsyncIteration
        return self._messages.pop(0)


async def test_the_read_filter_reports_the_end_of_the_transport_once_the_messages_are_read() -> None:
    ends: list[str] = []
    stream = mcp_mod._filter_malformed_mcp_progress_notifications(_ReadStream("one", "two"), "srv", lambda: ends.append("end"))

    seen = [message async for message in stream]

    assert seen == ["one", "two"]
    assert ends == ["end"]


async def test_a_provider_with_on_terminated_hears_an_idle_servers_end_only_while_it_is_live() -> None:
    ended: list[str] = []
    provider = MCPProvider({"srv": MCPServerConfig(command="fake")}, ToolRegistry(), on_terminated=ended.append)
    provider._connections["srv"] = SimpleNamespace(aclose=AsyncMock())  # type: ignore[assignment]

    provider._transport_ended("srv")
    provider._transport_ended("other")
    await provider.aclose()
    provider._transport_ended("srv")

    assert ended == ["srv"]


async def test_a_provider_without_on_terminated_does_nothing_about_the_end_of_the_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = MCPProvider({"srv": MCPServerConfig(command="fake")}, ToolRegistry())
    connection = SimpleNamespace(aclose=AsyncMock())
    provider._connections["srv"] = connection  # type: ignore[assignment]
    reconnect = AsyncMock()
    provider._refresh_terminated_server = reconnect  # type: ignore[method-assign]
    connect = AsyncMock()
    monkeypatch.setattr(mcp_mod, "connect_mcp_servers", connect)
    tasks_before = asyncio.all_tasks()

    provider._transport_ended("srv")
    await asyncio.sleep(0)

    # No reconnect, no new connection, nothing closed, nothing left running in the background.
    reconnect.assert_not_awaited()
    connect.assert_not_awaited()
    connection.aclose.assert_not_awaited()
    assert provider._connections == {"srv": connection}
    assert asyncio.all_tasks() == tasks_before


@pytest.mark.parametrize("params, error", [
    ({"team": "nanobot", "query": "bug"}, None),
    ({"team": "nanobot", "customView": "saved-view"}, None),
    ({"query": "bug"}, "missing required team"),
    ({"team": "nanobot", "customView": ""}, "customView must be at least 1 chars"),
])
async def test_optional_mcp_filters_reach_server_unchanged(params, error):
    async def call_tool(name, arguments):
        assert name == "list_issues"
        assert not ({"query", "customView"} <= arguments.keys())
        return SimpleNamespace(content=[_FakeTextContent("ok")])

    session = SimpleNamespace(call_tool=AsyncMock(side_effect=call_tool))
    wrapper = MCPToolWrapper(session, "linear", SimpleNamespace(
        name="list_issues",
        description="Search issues or use a saved view",
        inputSchema={
            "type": "object",
            "properties": {
                "team": {"type": "string"},
                "query": {"type": "string"},
                "customView": {"type": "string", "minLength": 1},
            },
            "required": ["team"],
        },
    ))
    registry = ToolRegistry()
    registry.register(wrapper)

    result = await run_tool(registry, wrapper.name, params)

    if error:
        assert is_tool_error_result(result)
        assert error in result
        session.call_tool.assert_not_awaited()
    else:
        assert result == "ok"
        session.call_tool.assert_awaited_once_with("list_issues", arguments=params)


def _image_call_tool(*blocks: object, is_error: bool = False) -> SimpleNamespace:
    async def call_tool(_name: str, arguments: dict) -> object:
        return SimpleNamespace(content=list(blocks), isError=is_error)

    return SimpleNamespace(call_tool=call_tool)


def _make_image_wrapper(session: object, *, images: bool) -> MCPToolWrapper:
    tool_def = SimpleNamespace(
        name="demo", description="demo tool", inputSchema={"type": "object", "properties": {}}
    )
    return MCPToolWrapper(session, "test", tool_def, images=images)


@pytest.mark.asyncio
async def test_execute_returns_image_blocks_in_server_order_when_images_are_kept() -> None:
    session = _image_call_tool(
        _FakeTextContent("before"),
        _FakeImageContent("QUJD", "image/png"),
        _FakeTextContent("after"),
    )

    result = await _make_image_wrapper(session, images=True).execute()

    assert result == [
        {"type": "text", "text": "before"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}},
        {"type": "text", "text": "after"},
    ]


@pytest.mark.asyncio
async def test_execute_returns_the_embedded_image_blob_as_base64_when_images_are_kept() -> None:
    class _EmbeddedResource:
        def __init__(self, resource: object) -> None:
            self.resource = resource

    class _Blob(_FakeBlobResourceContents):
        def __init__(self, blob: bytes, mime_type: str) -> None:
            super().__init__(blob)
            self.mimeType = mime_type

    sys.modules["mcp"].types.EmbeddedResource = _EmbeddedResource
    sys.modules["mcp"].types.BlobResourceContents = _Blob
    session = _image_call_tool(_EmbeddedResource(_Blob(b"ABC", "image/webp")))

    result = await _make_image_wrapper(session, images=True).execute()

    assert result == [{"type": "image_url", "image_url": {"url": "data:image/webp;base64,QUJD"}}]


@pytest.mark.asyncio
async def test_execute_keeps_a_result_without_an_image_a_string_when_images_are_kept() -> None:
    session = _image_call_tool(_FakeTextContent("one"), _FakeTextContent("two"))

    result = await _make_image_wrapper(session, images=True).execute()

    assert result == "one\ntwo"
    assert isinstance(result, str)


@pytest.mark.asyncio
async def test_execute_without_the_images_flag_never_returns_image_bytes() -> None:
    payload = "QUJD" * 64
    session = _image_call_tool(_FakeTextContent("shot"), _FakeImageContent(payload))

    result = await _make_image_wrapper(session, images=False).execute()

    assert isinstance(result, str)
    assert payload not in result


@pytest.mark.asyncio
async def test_execute_reports_an_error_result_as_text_even_when_images_are_kept() -> None:
    payload = "QUJD" * 64
    session = _image_call_tool(
        _FakeTextContent("page crashed"), _FakeImageContent(payload), is_error=True
    )

    result = await _make_image_wrapper(session, images=True).execute()

    assert is_tool_error_result(result)
    assert isinstance(result, str)
    assert result.startswith("page crashed")
    assert payload not in result


def test_server_config_does_not_keep_images_by_default() -> None:
    assert MCPServerConfig(command="fake").images is False
    assert MCPServerConfig(command="fake", images=True).images is True


@pytest.mark.asyncio
@pytest.mark.parametrize("images", [False, True])
async def test_connect_mcp_servers_passes_the_images_flag_to_the_tool_wrappers(
    fake_mcp_runtime: dict[str, object | None], images: bool
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo"])

    registry = ToolRegistry()
    stacks = await connect_mcp_servers({"test": MCPServerConfig(command="fake", images=images)}, registry)
    for stack in stacks.values():
        await stack.aclose()

    wrapper = registry.get("mcp_test_demo")
    assert isinstance(wrapper, MCPToolWrapper)
    assert wrapper._images is images


@pytest.mark.asyncio
async def test_each_server_uses_its_own_tool_timeout(
    fake_mcp_runtime: dict[str, object | None], monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo"])
    registry = ToolRegistry()
    stacks = await connect_mcp_servers(
        {
            "quick": MCPServerConfig(command="fake", tool_timeout=7),
            "browser": MCPServerConfig(command="fake", tool_timeout=120),
        },
        registry,
    )
    for stack in stacks.values():
        await stack.aclose()

    waited: list[float | None] = []
    real_wait_for = asyncio.wait_for

    async def recording_wait_for(awaitable: object, timeout: float | None = None) -> object:
        waited.append(timeout)
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr(mcp_mod.asyncio, "wait_for", recording_wait_for)
    session = SimpleNamespace(
        call_tool=AsyncMock(return_value=SimpleNamespace(content=[_FakeTextContent("ok")]))
    )
    for name in ("mcp_quick_demo", "mcp_browser_demo"):
        wrapper = registry.get(name)
        wrapper._session = session
        await wrapper.execute()

    assert waited == [7, 120]


@pytest.mark.asyncio
async def test_provider_connect_returns_no_failed_server_when_every_server_is_live(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo"])
    provider = MCPProvider({"test": MCPServerConfig(command="fake")}, ToolRegistry())

    assert await provider.connect() == []
    assert await provider.connect() == []

    await provider.aclose()


@pytest.mark.asyncio
async def test_provider_connect_returns_the_servers_that_failed_and_retries_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sessions = {"good": _make_fake_session(["demo"]), "bad": _make_fake_session(["other"])}
    broken = {"bad"}

    class _SelectiveClientSession:
        def __init__(self, read: object, _write: object) -> None:
            self._session = sessions[read]

        async def __aenter__(self) -> object:
            return self._session

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

    @asynccontextmanager
    async def _selective_stdio_client(params: object, errlog: object = None):
        if params.command in broken:
            raise RuntimeError("boom")
        yield params.command, object()

    monkeypatch.setattr(sys.modules["mcp"], "ClientSession", _SelectiveClientSession)
    monkeypatch.setattr(sys.modules["mcp.client.stdio"], "stdio_client", _selective_stdio_client)
    registry = ToolRegistry()
    provider = MCPProvider(
        {"bad": MCPServerConfig(command="bad"), "good": MCPServerConfig(command="good")}, registry
    )

    assert await provider.connect() == ["bad"]
    assert registry.tool_names == ["mcp_good_demo"]

    broken.clear()
    assert await provider.connect() == []
    assert sorted(registry.tool_names) == ["mcp_bad_other", "mcp_good_demo"]

    await provider.aclose()


@pytest.mark.asyncio
async def test_provider_connect_reports_every_server_when_the_batch_itself_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failing_connect(_servers: dict, _registry: ToolRegistry, *_ended: object, **_sinks: object) -> dict:
        raise RuntimeError("the transport layer is gone")

    monkeypatch.setattr(mcp_mod, "connect_mcp_servers", failing_connect)
    provider = MCPProvider(
        {"a": MCPServerConfig(command="a"), "b": MCPServerConfig(command="b")}, ToolRegistry()
    )

    assert await provider.connect() == ["a", "b"]


@pytest.mark.asyncio
async def test_provider_connect_after_close_connects_nothing_and_reports_the_servers(
    fake_mcp_runtime: dict[str, object | None],
) -> None:
    fake_mcp_runtime["session"] = _make_fake_session(["demo"])
    registry = ToolRegistry()
    provider = MCPProvider({"test": MCPServerConfig(command="fake")}, registry)
    await provider.aclose()

    assert await provider.connect() == ["test"]
    assert registry.tool_names == []
