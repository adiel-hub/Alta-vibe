"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { appFetch } from "@/lib/apiClient";

export type AgentListItem = {
  id: string;
  name: string;
  first_message: string;
  language: string;
  description: string;
  /** ISO date string. */
  updated_at: string;
};

export function AgentList({ initial }: { initial: AgentListItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This removes the agent on ElevenLabs and clears its chat history.`))
      return;
    setPendingId(id);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Delete failed (${res.status})`);
      }
      setItems((prev) => prev.filter((a) => a.id !== id));
      // Re-fetch the page in case the server-side list cache went stale.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setPendingId(null);
    }
  };

  if (items.length === 0) return null;

  return (
    <div>
      {error && <div className="agent-list-error">{error}</div>}
      <ul className="agent-list">
        {items.map((a) => {
          const isPending = pendingId === a.id;
          const initials =
            a.name
              .split(/\s+/)
              .filter(Boolean)
              .map((w) => w[0]?.toUpperCase() ?? "")
              .slice(0, 2)
              .join("") || "A";
          return (
            <li
              key={a.id}
              className={`agent-card ${isPending ? "agent-card-pending" : ""}`}
            >
              <Link
                href={`/agents/${a.id}`}
                className="agent-card-link"
                aria-label={`Open ${a.name}`}
              >
                <div className="agent-card-avatar" aria-hidden>
                  {initials}
                </div>
                <div className="agent-card-body">
                  <div dir="auto" className="agent-card-name">
                    {a.name}
                  </div>
                  {a.first_message && (
                    <div dir="auto" className="agent-card-greeting">
                      {a.first_message}
                    </div>
                  )}
                  <div className="agent-card-meta">
                    <span>{a.language?.toUpperCase() || "EN"}</span>
                    <span aria-hidden>·</span>
                    <span>
                      Updated{" "}
                      {new Date(a.updated_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </div>
              </Link>
              <button
                type="button"
                className="agent-card-delete"
                title={`Delete ${a.name}`}
                aria-label={`Delete ${a.name}`}
                disabled={isPending}
                onClick={() => void remove(a.id, a.name)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
