"""What the engine runs with, projected from the Dot config the host pushed (`PUT /config`).

Pure: the same config gives the same settings, and nothing is written. The
engine builds the settings when a config arrives and at start, and reads them
at the start of a turn; the gate reads the config itself at call time.
"""

from __future__ import annotations

from dataclasses import dataclass

from nanobot.dots.permissions import offered_mcp_servers, offered_tools
from nanobot.dots.protocol import MODEL_ROLES, DotRuntimeConfig

# Longest result of one tool call that goes back to the model, in characters.
MAX_TOOL_RESULT_CHARS = 12000


@dataclass(frozen=True)
class EngineSettings:
    model_id: str
    # The models the config names for the jobs other than the turn itself, as (role, model id) pairs in
    # role order (MODEL_ROLES); a tuple, as the settings are hashable.
    models: tuple[tuple[str, str], ...]
    # The OpenRouter API base URL for tests against a stand-in; None means the provider's own.
    openrouter_base_url: str | None
    # The tools of the permission table the model is offered: those whose permission is not denied.
    offered_tools: tuple[str, ...]
    # The declared MCP servers whose tools the model is offered (permission `mcp.<server>` not denied), by name.
    # Which tools those are is the servers' to say, when a turn starts (mcp_servers.py).
    mcp_servers: tuple[str, ...]
    max_iterations: int
    # What a task, or the chat between two answers, may spend on the model, in USD (see nanobot.dots.spend).
    max_cost_usd: float
    max_tool_result_chars: int
    workspace: str
    # The system prompt section that says whose Dot this is and what it is for.
    dot_prompt: str

    def model_for(self, role: str) -> str:
        """The model for a role: the one the config names for it, else the Dot's own model."""
        if role not in MODEL_ROLES:
            raise ValueError(f'unknown model role "{role}" (the roles are: {", ".join(MODEL_ROLES)})')
        return dict(self.models).get(role, self.model_id)


def project(config: DotRuntimeConfig, *, workspace: str, openrouter_base_url: str | None) -> EngineSettings:
    offered = offered_tools(config.permissions)
    named = config.models or {}
    return EngineSettings(
        model_id=config.model.id,
        models=tuple((role, named[role]) for role in MODEL_ROLES if role in named),
        openrouter_base_url=(openrouter_base_url or "").strip() or None,
        offered_tools=tuple(offered),
        mcp_servers=tuple(offered_mcp_servers(config.mcp_servers, config.permissions)),
        max_iterations=config.limits.max_steps_per_task,
        max_cost_usd=config.limits.max_cost_per_task_usd,
        max_tool_result_chars=MAX_TOOL_RESULT_CHARS,
        workspace=workspace,
        dot_prompt=dot_prompt_section(config),
    )


def dot_prompt_section(config: DotRuntimeConfig) -> str:
    """The system prompt section that tells the model whose Dot it is, and what its person asked of it."""
    lines = [f'You are the Dot "{config.name}".']
    instructions = (config.instructions or "").strip()
    if instructions:
        lines += ["", "Instructions from the person who owns you:", instructions]
    return "\n".join(lines)
