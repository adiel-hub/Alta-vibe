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
  doc,
  onRename,
  onRemove,
}: {
  doc: KnowledgeBaseDocument;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(doc.name);
  return (
    <div className="hover-lift flex items-center justify-between rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm">
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
        <div className="flex-1 min-w-0">
          <p className="truncate">{doc.name}</p>
          {doc.source && doc.source !== doc.name && (
            <p className="truncate text-xs text-(--color-muted)">{doc.source}</p>
          )}
        </div>
      )}
      <span className="ml-3 text-xs uppercase text-(--color-muted)">{doc.type}</span>
      <div className="ml-3 flex gap-1 text-xs">
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-(--color-muted) hover:text-(--color-foreground)"
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
  );
}
