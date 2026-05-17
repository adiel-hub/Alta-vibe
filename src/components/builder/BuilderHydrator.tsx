"use client";

import { useEffect } from "react";
import { useAgentStore, type ChatTurn } from "@/store/agentStore";
import type { AgentDTO } from "@/types/agent";

export function BuilderHydrator({
  agent,
  turns,
}: {
  agent: AgentDTO;
  turns: ChatTurn[];
}) {
  const hydrate = useAgentStore((s) => s.hydrate);
  useEffect(() => {
    hydrate(agent, turns);
  }, [hydrate, agent, turns]);
  return null;
}
