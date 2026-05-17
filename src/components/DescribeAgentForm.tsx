"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { appFetch } from "@/lib/apiClient";

const PLACEHOLDER =
  "A friendly receptionist for Cedar Hollow Dental that books cleanings, answers FAQs about insurance and hours, and triages dental emergencies to the on-call dentist.";

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
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `Request failed (${res.status})`,
        );
      }
      const json = (await res.json()) as { id: string };
      router.push(`/agents/${json.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit}>
      <div className="welcome-box">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onSubmit(e as unknown as React.FormEvent);
            }
          }}
          placeholder={PLACEHOLDER}
          rows={5}
          disabled={submitting}
        />
        <div className="welcome-box-row">
          <span style={{ flex: 1 }} />
          <span className="welcome-kbd">⌘ ⏎</span>
          <button
            type="submit"
            disabled={submitting || description.trim().length < 10}
            className="welcome-btn"
          >
            {submitting ? "Building…" : "Build it"}
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </div>
      {error && <div className="welcome-error">{error}</div>}
    </form>
  );
}
