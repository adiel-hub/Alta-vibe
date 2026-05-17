"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { appFetch } from "@/lib/apiClient";

const PLACEHOLDER =
  "A friendly bakery receptionist that takes phone orders, answers questions about our menu, and books pickup times. Warm but efficient. Should escalate to a human for refund requests.";

export function DescribeAgentForm() {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (description.trim().length < 10) {
      setError("Tell us a bit more — at least a sentence.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await appFetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      const json = (await res.json()) as { id: string };
      router.push(`/agents/${json.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-2xl flex-col gap-5">
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={PLACEHOLDER}
        rows={8}
        disabled={submitting}
        className="w-full resize-y rounded-2xl border border-(--color-border) bg-(--color-panel) px-5 py-4 text-base leading-relaxed shadow-inner outline-none focus:border-(--color-accent)"
      />
      {error && (
        <div className="rounded-lg border border-(--color-danger) bg-(--color-danger)/10 px-4 py-3 text-sm text-(--color-danger)">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-(--color-muted)">
          We&apos;ll spin up a starter agent you can shape from here.
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-full bg-(--color-accent) px-6 py-3 text-sm font-semibold text-(--color-accent-foreground) transition hover:brightness-110"
        >
          {submitting ? "Creating agent…" : "Continue →"}
        </button>
      </div>
    </form>
  );
}
