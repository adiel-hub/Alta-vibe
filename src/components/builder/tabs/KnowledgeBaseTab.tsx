"use client";

import { useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";

export function KnowledgeBaseTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const applyPatch = useAgentStore((s) => s.applyPatch);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!config) return null;

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
        patch: { knowledge_base: typeof config.knowledge_base };
      };
      applyPatch(json.revision, json.patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
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
            No documents yet. Paste a URL in chat, or upload a file below.
          </p>
        ) : (
          <ul className="space-y-2">
            {config.knowledge_base.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm"
              >
                <span className="truncate">{doc.name}</span>
                <span className="ml-3 text-xs uppercase text-(--color-muted)">
                  {doc.type}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="rounded-2xl border border-dashed border-(--color-border) p-5">
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.txt,.docx,.html,.epub"
          onChange={onPick}
          disabled={uploading}
          className="text-sm"
        />
        {uploading && <p className="mt-2 text-xs text-(--color-accent)">uploading…</p>}
        {error && <p className="mt-2 text-xs text-(--color-danger)">{error}</p>}
      </div>
    </div>
  );
}
