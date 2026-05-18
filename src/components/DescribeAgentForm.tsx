"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { appFetch } from "@/lib/apiClient";

const EXAMPLES = [
  "A friendly receptionist for Cedar Hollow Dental that books cleanings, answers FAQs about insurance and hours, and triages dental emergencies to the on-call dentist.",
  "A patient tech-support agent for our SaaS — walks customers through login, billing, and integration issues, escalates to a human when it can't help.",
  "A multilingual bakery hotline that takes phone orders, confirms pickup times, and answers menu/allergy questions warmly.",
  "An after-hours pharmacy assistant that triages refill requests, checks insurance, and pages the on-call pharmacist for emergencies.",
  "A real-estate receptionist that pre-qualifies leads, schedules showings, and forwards hot prospects to the agent on call.",
];

const TYPE_MS = 28; // ms per character typed
const ERASE_MS = 14; // ms per character erased
const HOLD_MS = 1800; // pause once a full example is shown
const GAP_MS = 280; // pause once erased before next example

/**
 * Drives a typewriter placeholder that cycles through example prompts.
 * Pauses while the textarea has user content so the placeholder doesn't
 * matter anyway. Resumes from the start of the cycle when cleared.
 */
function useTypingPlaceholder(active: boolean): string {
  const [text, setText] = useState("");
  const phase = useRef<{ idx: number; chars: number; mode: "type" | "hold" | "erase" | "gap" }>(
    { idx: 0, chars: 0, mode: "type" },
  );

  useEffect(() => {
    if (!active) return;
    let timer: NodeJS.Timeout | null = null;

    const tick = () => {
      const p = phase.current;
      const target = EXAMPLES[p.idx];
      if (p.mode === "type") {
        if (p.chars < target.length) {
          p.chars += 1;
          setText(target.slice(0, p.chars));
          timer = setTimeout(tick, TYPE_MS);
        } else {
          p.mode = "hold";
          timer = setTimeout(tick, HOLD_MS);
        }
      } else if (p.mode === "hold") {
        p.mode = "erase";
        timer = setTimeout(tick, ERASE_MS);
      } else if (p.mode === "erase") {
        if (p.chars > 0) {
          p.chars -= 1;
          setText(target.slice(0, p.chars));
          timer = setTimeout(tick, ERASE_MS);
        } else {
          p.mode = "gap";
          timer = setTimeout(tick, GAP_MS);
        }
      } else {
        p.idx = (p.idx + 1) % EXAMPLES.length;
        p.mode = "type";
        timer = setTimeout(tick, TYPE_MS);
      }
    };

    timer = setTimeout(tick, TYPE_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  return text;
}

export function DescribeAgentForm() {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typedPlaceholder = useTypingPlaceholder(
    description.length === 0 && !submitting,
  );

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
          placeholder={typedPlaceholder || EXAMPLES[0]}
          rows={5}
          disabled={submitting}
        />
        <div className="welcome-box-row">
          <span style={{ flex: 1 }} />
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
