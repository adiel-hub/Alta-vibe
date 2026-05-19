"use client";

import { useEffect, useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import { sendMessage } from "@/store/sseClient";
import { Button } from "@/components/ui/Button";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";

const PHASES: { id: RuntimePhase; label: string }[] = [
  { id: "pre_call", label: "Pre-Call" },
  { id: "in_call", label: "In-Call" },
  { id: "post_call", label: "Post-Call" },
];

const PHASE_HINTS: Record<RuntimePhase, string> = {
  pre_call:
    "Run before the agent greets the caller — e.g. look up caller history, decide which greeting to use.",
  in_call:
    "Run during the conversation — fetch data, take action, trigger workflows.",
  post_call:
    "Run after the call ends — log to CRM, send a summary email, file a ticket.",
};

type CatalogTool = {
  key: string;
  name: string;
  description: string;
  phase: RuntimePhase;
  method: string;
  category: string;
  default_install: boolean;
  installed: boolean;
};

type CatalogProvider = {
  id: string;
  name: string;
  description: string;
  icon: string;
  connected: boolean;
  tools: CatalogTool[];
};

/**
 * Smart token-based fuzzy matcher used by the search bar.
 *
 *  - Lowercases both query and haystack.
 *  - Treats `_` / `-` / whitespace as the same separator so "create contact"
 *    matches "hubspot_create_contact" and "create-contact" alike.
 *  - Requires every token in the query to appear as a substring (order-
 *    independent). Empty query matches everything.
 *
 * Callers pass an array of candidate fields — the matcher concatenates and
 * normalises them as one blob so you can ask "does this query hit ANY of
 * (provider name, tool wire name, friendly name, description, category)?"
 * with a single call.
 */
function normalizeForSearch(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[_\-/.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type FieldsMatcher = (fields: Array<string | undefined | null>) => boolean;

function makeMatcher(query: string): FieldsMatcher {
  const tokens = normalizeForSearch(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return () => true;
  return (fields) => {
    const blob = fields.map(normalizeForSearch).join(" ");
    return tokens.every((t) => blob.includes(t));
  };
}

export function ToolsTab() {
  const agent = useAgentStore((s) => s.agent);
  const config = useAgentStore((s) => s.config);

  const [activePhase, setActivePhase] = useState<RuntimePhase>("in_call");
  const [query, setQuery] = useState("");

  const fieldsMatch = useMemo(() => makeMatcher(query), [query]);
  const hasQuery = query.trim().length > 0;

  if (!config || !agent) return null;

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-5">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
        <SearchBar value={query} onChange={setQuery} />

        <PhaseTabs active={activePhase} onChange={setActivePhase} />

        <p className="mb-4 px-1 text-xs text-(--color-muted)">
          {PHASE_HINTS[activePhase]}
        </p>

        <IntegrationsSection
          agentId={agent.id}
          phase={activePhase}
          fieldsMatch={fieldsMatch}
          hasQuery={hasQuery}
        />
      </div>
    </div>
  );
}

// ── Skeleton primitives ──────────────────────────────────────────────────

function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mb-3 flex items-center gap-2 rounded-lg border border-(--color-border) bg-white px-3 py-2">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-(--color-muted)"
        aria-hidden
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search..."
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-(--color-muted)"
      />
    </label>
  );
}

function PhaseTabs({
  active,
  onChange,
}: {
  active: RuntimePhase;
  onChange: (p: RuntimePhase) => void;
}) {
  return (
    <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg border border-(--color-border) bg-(--color-panel-soft) p-1">
      {PHASES.map((p) => {
        const selected = active === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            className={`rounded-md py-1.5 text-sm transition ${
              selected
                ? "bg-(--color-panel) font-medium text-(--color-foreground-strong) shadow-sm"
                : "text-(--color-muted) hover:text-(--color-foreground)"
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function Section({
  title,
  busy,
  children,
}: {
  title: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
          {title}
        </h3>
        {busy && (
          <span className="text-xs text-(--color-accent)">syncing…</span>
        )}
      </div>
      {children}
    </div>
  );
}

function ProviderIcon({
  icon,
  name,
  size = "sm",
}: {
  icon: string;
  name: string;
  size?: "sm" | "lg";
}) {
  const imgClass =
    size === "lg" ? "h-10 w-10 shrink-0" : "h-5 w-5 shrink-0";
  const textClass = size === "lg" ? "text-3xl leading-none" : "text-base leading-none";
  if (icon.startsWith("/") || icon.startsWith("http")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={icon}
        alt={`${name} logo`}
        className={`${imgClass} rounded object-contain`}
      />
    );
  }
  return <span className={textClass}>{icon}</span>;
}

// ── Integrations ─────────────────────────────────────────────────────────

function IntegrationsSection({
  agentId,
  phase,
  fieldsMatch,
  hasQuery,
}: {
  agentId: string;
  phase: RuntimePhase;
  fieldsMatch: FieldsMatcher;
  hasQuery: boolean;
}) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const tools = useAgentStore((s) => s.config?.tools);
  const installedNames = useMemo(
    () => new Set(tools?.map((t) => t.name) ?? []),
    [tools],
  );

  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    appFetch(`/api/agents/${agentId}/provider-tools`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: { catalog: CatalogProvider[] }) => {
        if (!cancelled) setCatalog(data.catalog);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load integrations catalog.");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function install(provider: string, toolKey: string) {
    setBusyKey(`${provider}:${toolKey}`);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/provider-tools`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, tool_key: toolKey }),
      });
      const data = (await res.json()) as {
        revision?: number;
        tool?: RuntimeTool;
        error?: string;
      };
      if (!res.ok || !data.tool) {
        setError(data.error ?? `Install failed (${res.status})`);
        return;
      }
      const currentTools = useAgentStore.getState().config?.tools ?? [];
      applyConfigDirect(
        { tools: [...currentTools, data.tool] },
        data.revision ?? 0,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function uninstall(toolName: string) {
    setBusyKey(`uninstall:${toolName}`);
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/provider-tools?name=${encodeURIComponent(toolName)}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as {
        revision?: number;
        tools?: RuntimeTool[];
        error?: string;
      };
      if (!res.ok || !data.tools) {
        setError(data.error ?? `Uninstall failed (${res.status})`);
        return;
      }
      applyConfigDirect({ tools: data.tools }, data.revision ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      setBusyKey(null);
    }
  }

  // Only show providers that have at least one tool in the active phase
  // (and match the search), so the integration grid stays aligned with
  // the tab the user picked.
  const toolMatches = (p: CatalogProvider, t: CatalogTool) =>
    fieldsMatch([
      t.name,
      t.description,
      t.category,
      friendlyToolName(t.name, p.id, phase),
    ]);
  const providerMatches = (p: CatalogProvider) =>
    fieldsMatch([p.name, p.description]);

  const visibleProviders = (catalog ?? []).filter((p) => {
    const hasPhaseTool = p.tools.some((t) => t.phase === phase);
    if (!hasPhaseTool) return false;
    if (providerMatches(p)) return true;
    return p.tools.some((t) => t.phase === phase && toolMatches(p, t));
  });

  // Smart expand on search: when the user types something that only matches
  // tools inside one (or the first) provider, auto-open that provider's
  // drawer so the matching tool is one click closer. Skipped when there's
  // no query, so the manual expand/collapse UX stays intact otherwise.
  useEffect(() => {
    if (!hasQuery || !catalog) return;
    if (expanded && visibleProviders.some((p) => p.id === expanded)) return;
    const firstWithToolHit = visibleProviders.find((p) =>
      p.tools.some((t) => t.phase === phase && toolMatches(p, t)),
    );
    const target = firstWithToolHit ?? visibleProviders[0];
    if (target) setExpanded(target.id);
    // visibleProviders / toolMatches are derived from fieldsMatch + catalog
    // + phase, which are already in the deps. Recomputing them inside the
    // effect keeps the dependency surface small without risking stale
    // closure data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasQuery, fieldsMatch, phase, catalog]);

  return (
    <Section title="Integrations">
      {error && (
        <div className="mb-2 rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      {!catalog ? (
        <p className="rounded-lg border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-3 text-xs text-(--color-muted)">
          Loading catalog…
        </p>
      ) : visibleProviders.length === 0 ? (
        <p className="rounded-lg border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-3 text-xs text-(--color-muted)">
          No integrations for this phase.
        </p>
      ) : (
        <>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {visibleProviders.map((p) => {
              const isOpen = expanded === p.id;
              const phaseTools = p.tools.filter((t) => t.phase === phase);
              const installedCount = phaseTools.filter((t) =>
                installedNames.has(t.name),
              ).length;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : p.id)}
                    className={`relative flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border bg-white p-2 text-center transition hover:border-(--color-accent)/40 ${
                      isOpen
                        ? "border-(--color-accent)/60 ring-1 ring-(--color-accent)/40"
                        : "border-(--color-border)"
                    }`}
                  >
                    <span
                      className={`absolute right-2 top-2 h-1.5 w-1.5 rounded-full ${
                        p.connected ? "bg-emerald-400" : "bg-amber-400"
                      }`}
                      title={p.connected ? "Connected" : "Not connected"}
                    />
                    <ProviderIcon icon={p.icon} name={p.name} size="lg" />
                    <span className="line-clamp-2 text-sm font-medium leading-tight">
                      {p.name}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-(--color-muted)">
                      {installedCount}/{phaseTools.length} installed
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {expanded &&
            (() => {
              const p = visibleProviders.find((v) => v.id === expanded);
              if (!p) return null;
              return (
                <div className="mt-3 rounded-xl border border-(--color-border) bg-(--color-panel-soft)">
                  <div className="flex items-center justify-between gap-2 border-b border-(--color-border) px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <ProviderIcon icon={p.icon} name={p.name} />
                      <span className="truncate text-sm font-medium">
                        {p.name}
                      </span>
                      {p.connected && (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
                          connected
                        </span>
                      )}
                    </div>
                    {!p.connected && (
                      <ConnectProviderButton
                        agentId={agentId}
                        providerName={p.name}
                      />
                    )}
                  </div>
                  <ProviderToolList
                    provider={p}
                    phase={phase}
                    fieldsMatch={fieldsMatch}
                    hasQuery={hasQuery}
                    installedNames={installedNames}
                    busyKey={busyKey}
                    onInstall={install}
                    onUninstall={uninstall}
                  />
                </div>
              );
            })()}
        </>
      )}
    </Section>
  );
}

function ProviderToolList({
  provider,
  phase,
  fieldsMatch,
  hasQuery,
  installedNames,
  busyKey,
  onInstall,
  onUninstall,
}: {
  provider: CatalogProvider;
  phase: RuntimePhase;
  fieldsMatch: FieldsMatcher;
  hasQuery: boolean;
  installedNames: Set<string>;
  busyKey: string | null;
  onInstall: (providerId: string, toolKey: string) => void;
  onUninstall: (toolName: string) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // If the user typed something that hits the provider name itself (e.g.
  // "hubspot"), show all of its tools in this phase. If the query only
  // targets specific tools, narrow the list to just those — searching
  // "create contact" leaves you with the Create Contact tile already
  // visible and the matching category auto-selected.
  const providerMatches = fieldsMatch([provider.name, provider.description]);
  const phaseTools = provider.tools.filter((t) => {
    if (t.phase !== phase) return false;
    if (providerMatches && !hasQuery) return true;
    return fieldsMatch([
      t.name,
      t.description,
      t.category,
      friendlyToolName(t.name, provider.id, phase),
    ]);
  });
  const byCategory = new Map<string, CatalogTool[]>();
  for (const t of phaseTools) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }
  const categories = Array.from(byCategory.keys());

  const [activeCategory, setActiveCategory] = useState<string | null>(
    categories[0] ?? null,
  );
  // When there's a search, prefer the category that contains the most
  // matches over the user's last manual selection — so typing "create
  // contact" lands on "Contacts" instead of leaving you on whichever
  // category you clicked before.
  const bestSearchCategory =
    hasQuery && categories.length > 0
      ? [...byCategory.entries()].sort(
          (a, b) => b[1].length - a[1].length,
        )[0][0]
      : null;
  const effectiveCategory = bestSearchCategory
    ? bestSearchCategory
    : activeCategory && categories.includes(activeCategory)
      ? activeCategory
      : (categories[0] ?? null);

  return (
    <div className="px-3 py-3">
      {categories.length === 0 || !effectiveCategory ? (
        <p className="text-xs text-(--color-muted)">
          No tools for this phase.
        </p>
      ) : (
        <>
          <CategoryTabs
            categories={categories}
            active={effectiveCategory}
            onChange={(c) => {
              setActiveCategory(c);
              setSelectedKey(null);
            }}
          />
          <div className="mb-4 last:mb-0">
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {byCategory.get(effectiveCategory)!.map((t) => {
                const installed = installedNames.has(t.name);
                const installBusy = busyKey === `${provider.id}:${t.key}`;
                const uninstallBusy = busyKey === `uninstall:${t.name}`;
                const friendly = friendlyToolName(t.name, provider.id, phase);
                const isSelected = selectedKey === t.key;
                if (isSelected) {
                  return (
                    <li
                      key={t.key}
                      className="col-span-3 row-span-2 sm:col-span-2"
                    >
                      <div className="flex h-full flex-col rounded-xl border border-(--color-accent)/60 bg-white p-3 ring-1 ring-(--color-accent)/40">
                        <button
                          type="button"
                          onClick={() => setSelectedKey(null)}
                          className="flex items-start justify-between gap-2 text-left"
                        >
                          <h4 className="text-sm font-semibold leading-tight">
                            {friendly}
                          </h4>
                          <span className="shrink-0 rounded bg-(--color-panel-soft) px-1.5 py-0.5 text-[10px] font-medium text-(--color-muted)">
                            {t.method}
                          </span>
                        </button>
                        <p className="mt-2 flex-1 text-xs leading-snug text-(--color-muted)">
                          {t.description}
                        </p>
                        {installed ? (
                          <button
                            type="button"
                            disabled={uninstallBusy}
                            onClick={() => onUninstall(t.name)}
                            className="mt-2 w-full rounded-md border border-(--color-border) bg-(--color-panel-soft) px-2 py-1 text-xs hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
                          >
                            {uninstallBusy ? "Removing…" : "Remove"}
                          </button>
                        ) : provider.connected ? (
                          <button
                            type="button"
                            disabled={installBusy}
                            onClick={() => onInstall(provider.id, t.key)}
                            className="mt-2 w-full rounded-md border border-(--color-accent)/40 bg-(--color-accent)/10 px-2 py-1 text-xs text-(--color-accent) hover:bg-(--color-accent)/20 disabled:opacity-40"
                          >
                            {installBusy ? "Adding…" : "Add"}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={t.key}>
                    <button
                      type="button"
                      onClick={() => setSelectedKey(t.key)}
                      title={t.description}
                      className={`relative flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border bg-white p-2 text-center transition hover:border-(--color-accent)/40 ${
                        installed
                          ? "border-(--color-accent)/30"
                          : "border-(--color-border)"
                      }`}
                    >
                      {installed && (
                        <span
                          className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500"
                          title="Installed"
                        />
                      )}
                      <span className="line-clamp-3 text-[11px] font-medium leading-tight">
                        {friendly}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function ConnectProviderButton({
  agentId,
  providerName,
}: {
  agentId: string;
  providerName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      // Ask the builder agent to walk the user through OAuth/PAT — this is the
      // same flow as typing "Connect <Provider>" in chat, which the agent
      // answers with a connect_integration widget.
      await sendMessage(agentId, `Connect ${providerName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-[11px] text-(--color-danger)">{error}</span>
      )}
      <Button size="sm" disabled={busy} onClick={onConnect}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}

function CategoryTabs({
  categories,
  active,
  onChange,
}: {
  categories: string[];
  active: string;
  onChange: (c: string) => void;
}) {
  return (
    <div
      role="tablist"
      className="mb-3 flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg border border-(--color-border) bg-(--color-panel-soft) p-1"
    >
      {categories.map((c) => {
        const selected = active === c;
        return (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(c)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition ${
              selected
                ? "bg-white font-medium text-(--color-foreground-strong) shadow-sm"
                : "text-(--color-muted) hover:text-(--color-foreground)"
            }`}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

const UPPER_TOKENS = new Set([
  "id",
  "ids",
  "url",
  "api",
  "crm",
  "sms",
  "sql",
  "ai",
]);

function friendlyToolName(
  wireName: string,
  providerId: string,
  phase: RuntimePhase,
): string {
  let stripped = wireName;
  // The catalog phase-scopes wire names as `<phase>__<name>`; drop that prefix
  // because the tool is already shown under the active phase tab.
  const phasePrefix = `${phase}__`;
  if (stripped.startsWith(phasePrefix)) {
    stripped = stripped.slice(phasePrefix.length);
  }
  // Drop the provider prefix (e.g. `hubspot_`) — the tool sits inside the
  // provider's drawer, so prefixing every tile with the provider name is noise.
  const providerPrefix = `${providerId}_`;
  if (stripped.startsWith(providerPrefix)) {
    stripped = stripped.slice(providerPrefix.length);
  }
  return stripped
    .split("_")
    .filter(Boolean)
    .map((w) =>
      UPPER_TOKENS.has(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

