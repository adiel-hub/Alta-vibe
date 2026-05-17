"use client";

import { useAgentStore } from "@/store/agentStore";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";

const PHASES: { id: RuntimePhase; label: string; description: string }[] = [
  { id: "pre_call", label: "Pre-call", description: "Run before the agent greets the caller — e.g. look up caller history, decide which greeting to use." },
  { id: "in_call", label: "In-call", description: "Run during the conversation — fetch data, take action, trigger workflows." },
  { id: "post_call", label: "Post-call", description: "Run after the call ends — log to CRM, send a summary email, file a ticket." },
];

export function ToolsTab() {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  if (!config) return null;

  const byPhase: Record<RuntimePhase, RuntimeTool[]> = {
    pre_call: [],
    in_call: [],
    post_call: [],
  };
  for (const t of config.tools) byPhase[t.phase].push(t);

  return (
    <div className="space-y-5">
      {PHASES.map((p) => (
        <div key={p.id} className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
              {p.label} tools
            </h3>
            {inFlight.has("tools") && (
              <span className="text-xs text-(--color-accent)">syncing…</span>
            )}
          </div>
          <p className="mb-3 text-xs text-(--color-muted)">{p.description}</p>
          {byPhase[p.id].length === 0 ? (
            <p className="text-sm text-(--color-muted)">
              None. Ask in chat: <span className="italic">&quot;Create a {p.label.toLowerCase()} tool that {sampleFor(p.id)}.&quot;</span>
            </p>
          ) : (
            <ul className="space-y-2">
              {byPhase[p.id].map((t) => (
                <li
                  key={t.id}
                  className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2"
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs uppercase text-(--color-muted)">{t.type}</span>
                  </div>
                  {t.description && (
                    <p className="mt-1 text-xs text-(--color-muted)">{t.description}</p>
                  )}
                  {t.url && (
                    <p className="mt-1 truncate font-mono text-[11px] text-(--color-muted)">
                      {t.method ?? "POST"} {t.url}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            External integrations (MCP)
          </h3>
          {inFlight.has("mcp") && (
            <span className="text-xs text-(--color-accent)">syncing…</span>
          )}
        </div>
        {config.mcp_servers.length === 0 ? (
          <p className="text-sm text-(--color-muted)">
            Ask in chat: <span className="italic">&quot;Connect the Notion MCP server.&quot;</span>
          </p>
        ) : (
          <ul className="space-y-2">
            {config.mcp_servers.map((m) => (
              <li
                key={m.id}
                className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm"
              >
                <div className="font-medium">{m.name}</div>
                {m.url && (
                  <div className="truncate font-mono text-xs text-(--color-muted)">
                    {m.url}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function sampleFor(phase: RuntimePhase): string {
  switch (phase) {
    case "pre_call":
      return "looks up the caller in our CRM";
    case "in_call":
      return "checks the order status for a given order id";
    case "post_call":
      return "posts a summary to our Slack channel";
  }
}
