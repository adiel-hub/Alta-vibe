"use client";

import { useEffect } from "react";
import { useAgentStore, type ChatTurn, type WidgetEntry } from "@/store/agentStore";
import type { AgentDTO } from "@/types/agent";

export function BuilderHydrator({
  agent,
  turns,
  widgets,
}: {
  agent: AgentDTO;
  turns: ChatTurn[];
  widgets: WidgetEntry[];
}) {
  const hydrate = useAgentStore((s) => s.hydrate);
  useEffect(() => {
    hydrate(agent, turns, widgets);
  }, [hydrate, agent, turns, widgets]);
  return null;
}
