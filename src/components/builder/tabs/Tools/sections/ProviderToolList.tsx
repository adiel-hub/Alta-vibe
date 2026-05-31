import { useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";
import type {
  CatalogProvider,
  CatalogTool,
  FieldsMatcher,
  ToolsTabMode,
} from "../types";
import { friendlyToolName } from "../utils/names";
import { CategoryTabs } from "../primitives/CategoryTabs";

export function ProviderToolList({
  provider,
  phase,
  fieldsMatch,
  hasQuery,
  installedNames,
  busyKey,
  onInstall,
  mode = "manage",
  onPick,
}: {
  provider: CatalogProvider;
  phase: RuntimePhase;
  fieldsMatch: FieldsMatcher;
  hasQuery: boolean;
  installedNames: Set<string>;
  busyKey: string | null;
  // Async so pick mode can await install before reading the freshly-
  // attached RuntimeTool out of the store. Removal happens in
  // ToolboxSection, so the catalog drawer no longer needs an
  // onUninstall callback.
  onInstall: (providerId: string, toolKey: string) => Promise<void>;
  mode?: ToolsTabMode;
  onPick?: (tool: RuntimeTool) => void;
}) {
  const installedTools = useAgentStore((s) => s.config?.tools);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pickBusyKey, setPickBusyKey] = useState<string | null>(null);

  // In pick mode, tile click = pick directly (no expand step). Picking an
  // uninstalled provider tool installs it first, then reads the resulting
  // RuntimeTool from the store and fires onPick — the caller never sees
  // the install lifecycle.
  async function handlePick(t: CatalogTool) {
    const already = (installedTools ?? []).find((x) => x.name === t.name);
    if (already) {
      onPick?.(already);
      return;
    }
    if (!provider.connected) return;
    setPickBusyKey(t.key);
    try {
      await onInstall(provider.id, t.key);
      const fresh = (
        useAgentStore.getState().config?.tools ?? []
      ).find((x) => x.name === t.name);
      if (fresh) onPick?.(fresh);
    } finally {
      setPickBusyKey(null);
    }
  }

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
                        {mode === "pick" ? (
                          <button
                            type="button"
                            disabled={
                              pickBusyKey === t.key ||
                              (!installed && !provider.connected)
                            }
                            onClick={() => void handlePick(t)}
                            className="mt-2 w-full rounded-md bg-(--color-accent) px-2 py-1 text-xs font-semibold text-(--color-accent-foreground) transition hover:opacity-90 disabled:opacity-40"
                          >
                            {pickBusyKey === t.key
                              ? "Adding…"
                              : installed
                                ? "Use this tool"
                                : provider.connected
                                  ? "Install & use"
                                  : `Connect ${provider.name} first`}
                          </button>
                        ) : installed ? (
                          // Already in the toolbox — remove there, not here.
                          // Keeping the Remove button in two places was the
                          // confusing surface that hid the orphan bug.
                          <span className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700">
                            ✓ Added to toolbox
                          </span>
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
                const isPickBusy = pickBusyKey === t.key;
                return (
                  <li key={t.key}>
                    <button
                      type="button"
                      // Pick mode: tile click → pick directly (install
                      // first if needed). Manage mode: expand to show
                      // description + Add/Remove actions.
                      onClick={() => {
                        if (mode === "pick") {
                          void handlePick(t);
                        } else {
                          setSelectedKey(t.key);
                        }
                      }}
                      disabled={
                        mode === "pick" && !installed && !provider.connected
                      }
                      title={
                        mode === "pick" && !installed && !provider.connected
                          ? `Connect ${provider.name} from the Tools tab to use this`
                          : t.description
                      }
                      className={`relative flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border bg-white p-2 text-center transition hover:border-(--color-accent)/40 disabled:cursor-not-allowed disabled:opacity-50 ${
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
                      {isPickBusy && (
                        <span
                          className="absolute right-1.5 top-1.5 text-[9px] text-(--color-accent)"
                          aria-hidden
                        >
                          …
                        </span>
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
