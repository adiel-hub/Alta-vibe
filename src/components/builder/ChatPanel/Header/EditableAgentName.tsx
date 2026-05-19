"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import { createClientLogger } from "@/lib/clientLogger";
import { PenIcon } from "./icons";

const log = createClientLogger("chat");

export function EditableAgentName({
  agentId,
  value,
}: {
  agentId: string;
  value: string;
}) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Animated reveal of the name in view mode. `shown` is what's rendered;
  // it ramps up to `value` character-by-character whenever `value` changes
  // externally (e.g. update_agent_name fires). User-initiated saves bypass
  // the animation via `skipNextAnimRef` so the user doesn't see their own
  // typed name re-type itself.
  const [shown, setShown] = useState(value);
  const prevValueRef = useRef(value);
  const skipNextAnimRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [editing]);

  useEffect(() => {
    if (editing) return;
    if (prevValueRef.current === value) return;
    prevValueRef.current = value;

    if (skipNextAnimRef.current || !value) {
      skipNextAnimRef.current = false;
      setShown(value);
      return;
    }

    setShown("");
    let i = 0;
    const cps = 22;
    const id = window.setInterval(() => {
      i += 1;
      setShown(value.slice(0, i));
      if (i >= value.length) window.clearInterval(id);
    }, Math.round(1000 / cps));
    return () => window.clearInterval(id);
  }, [value, editing]);

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const save = async () => {
    const next = draft.trim();
    if (!next || next === value) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch(`/api/agents/${agentId}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const json = (await res.json()) as { revision: number };
      skipNextAnimRef.current = true;
      applyConfigDirect({ name: next }, json.revision);
      setEditing(false);
    } catch (err) {
      log.error("rename failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        disabled={saving}
        placeholder="Name the agent"
        aria-label="Agent name"
        className="w-[260px] rounded-sm bg-transparent px-1 py-0.5 text-[13px] font-semibold text-(--color-foreground-strong) outline-none disabled:opacity-60 placeholder:font-normal placeholder:text-(--color-muted-soft)"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename agent"
      className="group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition hover:bg-(--color-panel-soft)"
    >
      {shown && (
        <span className="truncate text-[13px] font-semibold text-(--color-foreground-strong)">
          {shown}
        </span>
      )}
      <PenIcon
        className={`h-3 w-3 shrink-0 text-(--color-muted) transition ${
          shown ? "opacity-0 group-hover:opacity-100" : "opacity-60"
        }`}
      />
    </button>
  );
}
