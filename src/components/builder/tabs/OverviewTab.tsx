"use client";

import { useAgentStore } from "@/store/agentStore";
import { EditableField } from "../EditableField";

export function OverviewTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  if (!config) return null;

  return (
    <div className="space-y-5">
      <EditableField
        agentId={agentId}
        field="name"
        label="Name"
        value={config.name}
        busy={inFlight.has("name")}
      />
      <EditableField
        agentId={agentId}
        field="first_message"
        label="First message"
        value={config.first_message}
        multiline
        rows={3}
        busy={inFlight.has("first_message")}
      />
      <EditableField
        agentId={agentId}
        field="system_prompt"
        label="System prompt"
        value={config.system_prompt}
        multiline
        rows={10}
        busy={inFlight.has("system_prompt")}
      />
    </div>
  );
}
