"use client";

import { useCallback, useEffect, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import { createClientLogger } from "@/lib/clientLogger";
import type { AgentConfigCache } from "@/types/agent";

const log = createClientLogger("version-history");

type Version = {
  id: string;
  branch_id?: string;
  /** Unix seconds (upstream field: `time_committed_secs`). */
  time_committed_secs?: number;
  /** Sequential version number on the branch (upstream: `seq_no_in_branch`). */
  seq_no_in_branch?: number;
  /** Upstream-generated change description (upstream: `version_description`). */
  version_description?: string;
  /**
   * Locally-generated title (Haiku). Present once `recordVersionForChange`
   * has run for this version; absent for older versions that pre-date the
   * meta-generation hook.
   */
  title?: string;
  /** Locally-generated short sentence summarising the change (Haiku). */
  description?: string;
};

type ListResponse = {
  versions: Version[];
  current_version_id: string | null;
  branch_id?: string;
};

type RestoreResponse = {
  revision: number;
  current_version_id: string | null;
  config_cache: AgentConfigCache;
};

/**
 * Inline version-history view. Rendered in place of the chat conversation
 * when the user toggles history on from the chat header. Fills its parent —
 * no fixed-position chrome — so the chat panel keeps its header and footer
 * around it.
 */
export function VersionHistoryPanel({
  agentId,
}: {
  agentId: string;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const currentVersionId = useAgentStore((s) => s.currentVersionId);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const setCurrentVersionId = useAgentStore((s) => s.setCurrentVersionId);
  const revision = useAgentStore((s) => s.revision);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/versions`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load history (${res.status})`);
      }
      const json = (await res.json()) as ListResponse;
      // Newest first. time_committed_secs is unix seconds; if missing, fall
      // back to seq_no_in_branch (higher = newer) so the order stays sane.
      const sorted = [...json.versions].sort((a, b) => {
        const at = a.time_committed_secs ?? 0;
        const bt = b.time_committed_secs ?? 0;
        if (at !== bt) return bt - at;
        return (b.seq_no_in_branch ?? 0) - (a.seq_no_in_branch ?? 0);
      });
      setVersions(sorted);
      if (json.current_version_id && json.current_version_id !== currentVersionId) {
        setCurrentVersionId(json.current_version_id);
      }
    } catch (err) {
      log.error("load failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [agentId, currentVersionId, setCurrentVersionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = async (versionId: string) => {
    if (
      !window.confirm(
        "Restore this version? Your current configuration will be saved as part of the history.",
      )
    ) {
      return;
    }
    setRestoringId(versionId);
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/versions/${versionId}/restore`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Restore failed (${res.status})`);
      }
      const json = (await res.json()) as RestoreResponse;
      applyConfigDirect(json.config_cache, json.revision);
      if (json.current_version_id) {
        setCurrentVersionId(json.current_version_id);
      }
      // Refresh the list so the new top-of-history entry shows up.
      await refresh();
    } catch (err) {
      log.error("restore failed", {
        version_id: versionId,
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoringId(null);
    }
  };

  // The topmost row is current by definition (auto-versioning is append-only),
  // but prefer the cached id when present so the badge is exact.
  const liveId = currentVersionId ?? versions[0]?.id ?? null;

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="border-b border-(--color-danger)/40 bg-(--color-red-50) px-5 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading && versions.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-(--color-muted)">
            Loading…
          </div>
        ) : versions.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-(--color-muted)">
            No versions yet. They appear automatically as the agent is edited.
          </div>
        ) : (
          <ol className="space-y-1.5">
            {versions.map((v) => {
              const isLive = v.id === liveId;
              const isRestoring = restoringId === v.id;
              return (
                <li
                  key={v.id}
                  className={`group rounded-md border px-3 py-2 transition ${
                    isLive
                      ? "border-(--color-accent)/40 bg-(--color-accent)/5"
                      : "border-(--color-border) bg-(--color-panel) hover:border-(--color-border-strong)"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-(--color-foreground-strong)">
                        <span>{titleForVersion(v)}</span>
                        {isLive && (
                          <span className="rounded-full bg-(--color-accent) px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wider text-white">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] text-(--color-muted-soft)">
                        {formatRelative(v.time_committed_secs)}
                      </div>
                      {(() => {
                        const desc = descriptionForVersion(v);
                        if (!desc) return null;
                        return (
                          <div className="mt-1 line-clamp-2 text-[11px] text-(--color-muted)">
                            {desc}
                          </div>
                        );
                      })()}
                    </div>
                    {!isLive && (
                      <button
                        type="button"
                        onClick={() => void restore(v.id)}
                        disabled={isRestoring || restoringId !== null}
                        className="shrink-0 rounded-md border border-(--color-border) bg-(--color-panel) px-2.5 py-1 text-[11px] font-medium text-(--color-foreground-strong) transition hover:border-(--color-accent) hover:text-(--color-accent) disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isRestoring ? "Restoring…" : "Restore"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <footer className="shrink-0 border-t border-(--color-border) px-5 py-2 text-[10px] text-(--color-muted-soft)">
        Revision {revision}
      </footer>
    </div>
  );
}

function formatRelative(committedSecs: number | undefined): string {
  if (!committedSecs) return "Unknown time";
  const ms = committedSecs * 1000;
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return "Just now";
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60);
    return `${m} min ago`;
  }
  if (diffSec < 86_400) {
    const h = Math.floor(diffSec / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(diffSec / 86_400);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * ElevenLabs' auto-versioning sets `version_description` to this exact
 * boilerplate for every version it auto-creates. It carries zero info,
 * so we treat it as "no description" and fall back to a synthesized title.
 */
const UPSTREAM_BOILERPLATE_DESCRIPTIONS: ReadonlySet<string> = new Set([
  "New version of your agent.",
  "New version of your agent",
]);

function isMeaningfulDescription(raw: string | undefined): raw is string {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  return !UPSTREAM_BOILERPLATE_DESCRIPTIONS.has(trimmed);
}

/**
 * Build a human-friendly row title. Resolution order:
 *   1. Our locally-generated Haiku title (the good case for any version
 *      created since the meta-generation hook landed).
 *   2. A non-boilerplate upstream `version_description`.
 *   3. "Version N" from `seq_no_in_branch`.
 *   4. Generic "Edit" as a last resort.
 */
function titleForVersion(v: Version): string {
  const local = v.title?.trim();
  if (local) return local;
  const desc = v.version_description?.trim();
  if (isMeaningfulDescription(desc) && desc.length <= 60) return desc;
  if (v.seq_no_in_branch !== undefined) return `Version ${v.seq_no_in_branch}`;
  return "Edit";
}

/**
 * Subtitle description. Prefer our locally-generated sentence; otherwise
 * fall back to a non-boilerplate upstream description; otherwise null.
 * Always returns null if the resolved string would just duplicate the
 * row title.
 */
function descriptionForVersion(v: Version): string | null {
  const candidate = v.description?.trim() || v.version_description?.trim();
  if (!isMeaningfulDescription(candidate)) return null;
  if (candidate === titleForVersion(v)) return null;
  return candidate;
}
