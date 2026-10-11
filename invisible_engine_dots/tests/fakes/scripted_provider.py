"""A model provider that answers from a script, for the tests of the turn runner.

Every request the runner makes is recorded (deep-copied, so later mutation of the
transcript cannot change what the model was asked) and answered by the next entry
of the script:
- an LLMResponse is returned;
- an exception instance is raised;
- a response that reports no cost is stamped with `default_cost` (what OpenRouter's usage.cost is on a
  real one; None leaves it unpriced, as a gateway that sends no cost does);
- a callable is called with the provider and returns one of the above, or an
  awaitable of one of them, which lets a test look at the world at the moment the
  model is asked, and hold the answer back (`Gate`).
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from copy import deepcopy
from typing import Any

from nanobot.providers.base import (
    GenerationSettings,
    LLMProvider,
    LLMResponse,
    ModelLimits,
    ToolCallRequest,
)

ScriptEntry = LLMResponse | BaseException | Callable[["ScriptedProvider"], Any]


def says(text: str, *, cost: float | None = None) -> LLMResponse:
    return LLMResponse(content=text, cost_usd=cost)


def calls(*tool_calls: ToolCallRequest, text: str | None = None, cost: float | None = None) -> LLMResponse:
    return LLMResponse(content=text, tool_calls=list(tool_calls), finish_reason="tool_calls", cost_usd=cost)


def call(call_id: str, name: str, /, **arguments: Any) -> ToolCallRequest:
    return ToolCallRequest(id=call_id, name=name, arguments=arguments)


class Gate:
    """Holds one answer of the model back until the test lets it go.

    `reached` is set when the runner asks the model for this entry; the answer
    comes back once `release` is set. A turn cancelled while it waits here is
    cancelled in the model request, as a prepare-sleep does it.
    """

    def __init__(self) -> None:
        self.reached = asyncio.Event()
        self.release = asyncio.Event()

    async def wait_reached(self, timeout_s: float = 10.0) -> None:
        await asyncio.wait_for(self.reached.wait(), timeout_s)

    def holds(self, answer: LLMResponse | BaseException) -> Callable[[ScriptedProvider], Any]:
        async def wait(provider: ScriptedProvider) -> LLMResponse | BaseException:
            self.reached.set()
            await self.release.wait()
            return answer

        return wait


class ScriptedProvider(LLMProvider):
    def __init__(
        self, script: list[ScriptEntry], *, max_tokens: int = 1000, default_cost: float | None = 0.0
    ) -> None:
        super().__init__(provider_name="scripted")
        self.script = list(script)
        self.default_cost = default_cost
        self.requests: list[dict[str, Any]] = []
        # The ProviderCallContext of each request, kept apart from `requests`, which tests serialize.
        self.contexts: list[Any] = []
        self.generation = GenerationSettings(max_tokens=max_tokens)
        # What the stand-in publishes for every model (a test changes it, or names a model's own in `limits`): the
        # window of the smaller models Dots run on (kimi-k2 publishes 131072). A turn with every permission, the
        # browser server's tools and instructions included, is about 34000 tokens by the engine's estimate.
        self.default_limits = ModelLimits(context_tokens=128_000, answer_tokens=max_tokens)
        self.limits: dict[str, ModelLimits] = {}

    async def chat_stream(self, *args: Any, **kwargs: Any) -> LLMResponse:
        raise AssertionError("the runner asks through chat_stream_with_retry")

    def get_default_model(self) -> str:
        return "scripted/model"

    async def model_limits(self, model: str) -> ModelLimits:
        return self.limits.get(model, self.default_limits)

    async def chat_stream_with_retry(self, **kwargs: Any) -> LLMResponse:  # type: ignore[override]
        self.requests.append(
            {
                "messages": deepcopy(kwargs["messages"]),
                "tools": deepcopy(kwargs.get("tools")),
                "model": kwargs.get("model"),
                "max_tokens": kwargs.get("max_tokens"),
            }
        )
        self.contexts.append(kwargs.get("provider_context"))
        if not self.script:
            raise AssertionError(f"the model was asked {len(self.requests)} times, the script has fewer answers")
        entry = self.script.pop(0)
        if callable(entry):
            entry = entry(self)
        if inspect.isawaitable(entry):
            entry = await entry
        if isinstance(entry, BaseException):
            raise entry
        if entry.cost_usd is None and entry.finish_reason != "error":
            entry.cost_usd = self.default_cost
        return entry

    @property
    def tool_names(self) -> list[list[str]]:
        """The names of the tools each request offered."""
        return [
            [tool["function"]["name"] for tool in request["tools"] or []]
            for request in self.requests
        ]
