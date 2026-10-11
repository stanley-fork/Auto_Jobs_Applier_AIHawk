"use client";

import { computerIsUp } from "@invisible-dots/shared/browser";
import { api } from "../../lib/api";
import { isComputerStopped } from "../../lib/computer";
import { useLiveRefresh } from "../events";
import { useResource } from "../ui";

/**
 * The Dot's tool table as its engine has it (`GET /tools`): every tool with the permission it uses and whether the
 * model is offered it, and the MCP servers the config declares with where each is. Only a running computer has one to
 * read, so a stopped one is not asked (null). The table changes when a config is pushed and when the computer comes up.
 */
export function useToolTable(dotId: string, computerState: string | null | undefined) {
  const up = computerIsUp(computerState);
  const table = useResource(async () => {
    if (!up) return null;
    try {
      return await api.listTools(dotId);
    } catch (error) {
      // The computer went down between the state and the question: the same as not running.
      if (isComputerStopped(error)) return null;
      throw error;
    }
  }, `tools:${dotId}:${up}`);
  useLiveRefresh(table.reload, ["dot.updated", "computer.state"]);
  return table;
}

export type ToolTable = ReturnType<typeof useToolTable>;
