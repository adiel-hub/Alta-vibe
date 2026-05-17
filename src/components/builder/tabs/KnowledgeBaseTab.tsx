"use client";

import { useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type { KnowledgeBaseDocument } from "@/types/agent";

export function KnowledgeBaseTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!config) return null;

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await appFetch(`/api/agents/${agentId}/knowledge-base/file`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Upload failed (${res.status})`);
      }
      const json = (await res.json()) as {
        revision: number;
        patch: { knowledge_base: KnowledgeBaseDocument[] };
      };
      applyConfigDirect(json.patch, json.revision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (docId: string) => {
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/knowledge-base/${docId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      const json = (await res.json()) as {
        revision: number;
        patch: { knowledge_base: KnowledgeBaseDocument[] };
      };
      applyConfigDirect(json.patch, json.revision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const rename = async (docId: string, name: string) => {
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/knowledge-base/${docId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!res.ok) throw new Error(`Rename failed (${res.status})`);
      const json = (await res.json()) as {
        revision: number;
        patch: { knowledge_base: KnowledgeBaseDocument[] };
      };
      applyConfigDirect(json.patch, json.revision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Knowledge base
          </h3>
          {inFlight.has("knowledge_base") && (
            <span className="text-xs text-(--color-accent)">syncing…</span>
          )}
        </div>
        {config.knowledge_base.length === 0 ? (
          <p className="text-sm text-(--color-muted)">
            No documents yet. Try in chat: <span className="italic">&quot;Scrape https://your-docs.example.com into the knowledge base.&quot;</span>
          </p>
        ) : (
          <ul className="space-y-2">
            {config.knowledge_base.map((doc, i) => (
              <li
                key={doc.id}
                style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                className="animate-message-in"
              >
                <KbRow
                  agentId={agentId}
                  doc={doc}
                  onRename={(n) => rename(doc.id, n)}
                  onRemove={() => remove(doc.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-dashed border-(--color-border) p-5">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          Upload a file
        </h4>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.txt,.docx,.html,.epub,.md"
          onChange={upload}
          disabled={uploading}
          className="text-sm"
        />
        {uploading && (
          <p className="mt-2 text-xs text-(--color-accent)">uploading…</p>
        )}
        <p className="mt-3 text-xs text-(--color-muted)">
          You can also paste a URL in chat to scrape a single page, or ask to
          crawl an entire docs site.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-(--color-danger) bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}
    </div>
  );
}

function KbRow({
  agentId,
  doc,
  onRename,
  onRemove,
}: {
  agentId: string;
  doc: KnowledgeBaseDocument;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(doc.name);
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const loadContent = async () => {
    if (content !== null || loadingContent) return;
    setLoadingContent(true);
    setContentError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/knowledge-base/${doc.id}/content`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Fetch failed (${res.status})`);
      }
      const json = (await res.json()) as { content: string };
      setContent(json.content);
    } catch (err) {
      setContentError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setLoadingContent(false);
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadContent();
  };

  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) text-sm">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="grid h-5 w-5 place-items-center rounded text-(--color-muted-soft) hover:text-(--color-foreground-strong)"
        >
          <span
            style={{
              display: "inline-block",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.15s",
            }}
          >
            ▸
          </span>
        </button>
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRename(draft);
                setEditing(false);
              }
              if (e.key === "Escape") {
                setDraft(doc.name);
                setEditing(false);
              }
            }}
            autoFocus
            className="flex-1 rounded-md border border-(--color-border) bg-(--color-panel) px-2 py-1 text-sm"
          />
        ) : (
          <button
            type="button"
            onClick={toggle}
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left"
          >
            <span className="truncate font-medium text-(--color-foreground-strong)">
              {doc.name}
            </span>
            {doc.source && doc.source !== doc.name && (
              <span className="truncate font-mono text-[11px] text-(--color-muted)">
                {doc.source}
              </span>
            )}
          </button>
        )}
        <span className="font-mono text-[10px] uppercase tracking-widest text-(--color-muted-soft)">
          {doc.type}
        </span>
        <div className="flex gap-2 text-xs">
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-(--color-muted) hover:text-(--color-foreground-strong)"
            >
              rename
            </button>
          )}
          <button
            onClick={onRemove}
            className="text-(--color-danger) hover:brightness-110"
          >
            remove
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-(--color-border) px-3 py-3">
          {loadingContent && (
            <p className="font-mono text-[11px] text-(--color-muted-soft)">
              Loading indexed content…
            </p>
          )}
          {contentError && (
            <p className="text-xs text-(--color-danger)">{contentError}</p>
          )}
          {content !== null && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-(--color-panel) p-3 font-mono text-[11px] leading-relaxed text-(--color-foreground)">
              {content || "(empty)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
