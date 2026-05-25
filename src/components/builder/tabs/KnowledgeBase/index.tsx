"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type { KnowledgeBaseDocument } from "@/types/agent";
import { useKnowledgeReveal } from "./useKnowledgeReveal";
import { useTypewriter } from "../_shared/useTypewriter";

export function KnowledgeBaseTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reveal hook must be called before the early return so hook order is
  // stable across renders. It safely no-ops on an empty array.
  const docs = config?.knowledge_base ?? [];
  const { isRevealed, isTyping } = useKnowledgeReveal(docs);

  if (!config) return null;

  const upload = async (file: File) => {
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
    <div className="mx-auto flex max-w-[760px] flex-col gap-4">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Knowledge base
          </h3>
          {inFlight.has("knowledge_base") && (
            <span className="text-xs text-(--color-accent)">syncing…</span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {config.knowledge_base
            .filter((doc) => isRevealed(doc.id))
            .map((doc, i) => (
              <div
                key={doc.id}
                style={{
                  // Newly-revealed cards animate from 0ms (they already
                  // waited via the stagger timer). Hydrated cards keep
                  // the gentle cascade.
                  animationDelay: isTyping(doc.id)
                    ? "0ms"
                    : `${Math.min(i, 8) * 40}ms`,
                }}
                className="animate-message-in"
              >
                <KbCard
                  agentId={agentId}
                  doc={doc}
                  typewriter={isTyping(doc.id)}
                  onRename={(n) => rename(doc.id, n)}
                  onRemove={() => remove(doc.id)}
                />
              </div>
            ))}
          <div
            style={{
              animationDelay: `${Math.min(config.knowledge_base.length, 8) * 40}ms`,
            }}
            className="animate-message-in"
          >
            <UploadCard
              inputRef={inputRef}
              uploading={uploading}
              onPick={upload}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-(--color-danger) bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}
    </div>
  );
}

const ACCEPTED_EXTS = ".pdf,.txt,.docx,.html,.epub,.md";

function UploadCard({
  inputRef,
  uploading,
  onPick,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  uploading: boolean;
  onPick: (file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (uploading) return;
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Only un-highlight if the pointer left the card entirely (not just
    // moved over a child).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onPick(file);
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !uploading) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      className={
        "group relative flex h-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition " +
        (dragging
          ? "border-(--color-accent) bg-(--color-accent)/5"
          : "border-(--color-border) bg-(--color-panel) hover:border-(--color-accent)/50 hover:bg-(--color-panel-soft)")
      }
    >
      <div
        className="grid h-8 w-8 place-items-center rounded-full bg-(--color-panel-soft) text-(--color-muted) transition group-hover:text-(--color-accent)"
        aria-hidden
      >
        {uploading ? (
          <span
            className="block h-3.5 w-3.5 rounded-full border-[1.5px] border-current/30 border-t-current"
            style={{ animation: "vask-spin 0.8s linear infinite" }}
          />
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        )}
      </div>

      <p className="text-xs font-semibold leading-tight text-(--color-foreground-strong)">
        {uploading
          ? "Uploading…"
          : dragging
            ? "Drop to upload"
            : "Add a document"}
      </p>
      <p className="font-mono text-[10px] uppercase tracking-wider text-(--color-muted)">
        PDF · DOCX · TXT · MD · HTML
      </p>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXTS}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
        }}
        disabled={uploading}
        className="sr-only"
      />
    </div>
  );
}

function KbCard({
  agentId,
  doc,
  typewriter,
  onRename,
  onRemove,
}: {
  agentId: string;
  doc: KnowledgeBaseDocument;
  typewriter: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(doc.name);
  // When the agent just created this doc we want the body open so the
  // content can type in. Manual interaction afterwards still wins.
  const [expanded, setExpanded] = useState(typewriter);
  const [content, setContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const markKbAnimationDone = useAgentStore((s) => s.markKbAnimationDone);

  const loadContent = useCallback(async () => {
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
  }, [agentId, doc.id, content, loadingContent]);

  // Auto-load the content for a newly-created doc so the body can type
  // itself in once the title/source finish.
  useEffect(() => {
    if (typewriter && content === null && !loadingContent) {
      void loadContent();
    }
  }, [typewriter, content, loadingContent, loadContent]);

  // If the content fetch fails for a newly-created doc, still clear the
  // pending-animation flag so we don't replay the typewriter on every
  // future tab open just because the body couldn't load.
  useEffect(() => {
    if (typewriter && contentError) {
      markKbAnimationDone(doc.id);
    }
  }, [typewriter, contentError, doc.id, markKbAnimationDone]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadContent();
  };

  // Typewriter the title first, then the source line, then the content —
  // the agent fills out one field at a time.
  const typedName = useTypewriter(doc.name, typewriter, 55);
  const sourceText =
    doc.source && doc.source !== doc.name ? doc.source : "";
  const nameDone = typedName.length >= doc.name.length;
  const typedSource = useTypewriter(sourceText, typewriter && nameDone, 80);
  const sourceDone =
    !sourceText || typedSource.length >= sourceText.length;

  const contentText = content ?? "";
  const contentReady = typewriter && nameDone && sourceDone && content !== null;
  const onContentDone = useCallback(() => {
    markKbAnimationDone(doc.id);
  }, [doc.id, markKbAnimationDone]);
  const typedContent = useTypewriter(
    contentText,
    contentReady,
    220,
    onContentDone,
  );
  const showNameCursor = typewriter && !nameDone;
  const showSourceCursor =
    typewriter &&
    nameDone &&
    sourceText.length > 0 &&
    typedSource.length < sourceText.length;
  const showContentCursor =
    contentReady && typedContent.length < contentText.length;

  return (
    <div
      role="button"
      tabIndex={editing ? -1 : 0}
      onClick={() => {
        if (editing) return;
        toggle();
      }}
      onKeyDown={(e) => {
        if (editing) return;
        // Only react to keys fired on the card itself — keyboard activations
        // on nested buttons (rename, trash, chevron) handle themselves.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
      className="group relative flex h-full cursor-pointer flex-col gap-3 rounded-xl border border-(--color-border) bg-(--color-panel) p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition hover:-translate-y-0.5 hover:border-(--color-border-strong) hover:shadow-[0_6px_18px_rgba(0,0,0,0.06)]"
    >
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
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
            className="min-w-0 flex-1 rounded-md border border-(--color-border) bg-(--color-panel-soft) px-2 py-1 text-sm"
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col items-start text-left">
            <span
              dir="auto"
              className="line-clamp-2 text-sm font-semibold leading-snug text-(--color-foreground-strong)"
            >
              {typedName}
              {showNameCursor && (
                <span
                  aria-hidden
                  className="ml-[1px] inline-block h-[1em] w-[2px] translate-y-[2px] animate-cursor bg-current align-baseline"
                />
              )}
            </span>
            {sourceText && (
              <span className="mt-1 line-clamp-1 break-all font-mono text-[11px] text-(--color-muted)">
                {typedSource}
                {showSourceCursor && (
                  <span
                    aria-hidden
                    className="ml-[1px] inline-block h-[1em] w-[2px] translate-y-[2px] animate-cursor bg-current align-baseline"
                  />
                )}
              </span>
            )}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {/* Hidden by default; revealed on card hover (parent has `group`)
              or whenever an action inside is focused (keyboard nav). The
              chevron sits next to them and is always visible. */}
          <div
            className={`flex items-center gap-1 transition-opacity ${
              editing
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
            }`}
          >
            {!editing && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
                title="Rename"
                aria-label="Rename"
                className="grid h-6 w-6 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
              >
                <PencilIcon />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              title="Remove"
              aria-label="Remove"
              className="grid h-6 w-6 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-danger)/10 hover:text-(--color-danger)"
            >
              <TrashIcon />
            </button>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="grid h-6 w-6 place-items-center rounded-md text-(--color-muted-soft) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
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
        </div>
      </div>

      {expanded && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="-mx-4 -mb-4 mt-1 rounded-b-xl border-t border-(--color-border) bg-(--color-panel-soft) px-1 py-1"
        >
          {loadingContent && (
            <p className="font-mono text-[11px] text-(--color-muted-soft)">
              Loading indexed content…
            </p>
          )}
          {contentError && (
            <p className="text-xs text-(--color-danger)">{contentError}</p>
          )}
          {content !== null && (
            <pre
              dir="auto"
              className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-(--color-panel) p-3 font-mono text-[11px] leading-relaxed text-(--color-foreground)"
            >
              {contentReady ? typedContent : content || "(empty)"}
              {showContentCursor && (
                <span
                  aria-hidden
                  className="ml-[1px] inline-block h-[1em] w-[2px] translate-y-[2px] animate-cursor bg-current align-baseline"
                />
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
