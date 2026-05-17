"use client";

import { useAgentStore } from "@/store/agentStore";

export function ToolsTab() {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  if (!config) return null;

  return (
    <div className="space-y-4">
      <Card title="Runtime tools" busy={inFlight.has("tools")}>
        {config.tools.length === 0 ? (
          <p className="text-sm text-(--color-muted)">
            Ask in chat: <span className="italic">&quot;Add a webhook tool to look up orders&quot;</span>
          </p>
        ) : (
          <ul className="space-y-2">
            {config.tools.map((t) => (
              <li
                key={t.id}
                className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2"
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-xs uppercase text-(--color-muted)">
                    {t.type}
                  </span>
                </div>
                {t.description && (
                  <p className="mt-1 text-xs text-(--color-muted)">{t.description}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="MCP integrations" busy={inFlight.has("mcp")}>
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
                  <div className="font-mono text-xs text-(--color-muted)">{m.url}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Card({
  title,
  busy,
  children,
}: {
  title: string;
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          {title}
        </h3>
        {busy && <span className="text-xs text-(--color-accent)">syncing…</span>}
      </div>
      {children}
    </div>
  );
}
