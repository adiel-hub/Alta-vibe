"use client";

import { useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";

export function PhoneTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const [toNumber, setToNumber] = useState("");
  const [selectedPhoneId, setSelectedPhoneId] = useState<string>(
    config?.phone_numbers[0]?.id ?? "",
  );
  const [dialing, setDialing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!config) return null;

  const dial = async () => {
    if (!selectedPhoneId || !toNumber.trim()) return;
    setDialing(true);
    setResult(null);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/outbound-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to_number: toNumber.trim(),
          agent_phone_number_id: selectedPhoneId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Call failed (${res.status})`);
      }
      const json = (await res.json()) as { conversation_id: string };
      setResult(`Call placed. Conversation id: ${json.conversation_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Call failed");
    } finally {
      setDialing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Attached phone numbers
          </h3>
          {inFlight.has("phone") && (
            <span className="text-xs text-(--color-accent)">syncing…</span>
          )}
        </div>
        {config.phone_numbers.length === 0 ? (
          <p className="text-sm text-(--color-muted)">
            No phone numbers yet. Ask in chat:{" "}
            <span className="italic">&quot;List my phone numbers and attach the first one.&quot;</span>
          </p>
        ) : (
          <ul className="space-y-2">
            {config.phone_numbers.map((p) => (
              <li
                key={p.id}
                className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm"
              >
                <div className="flex justify-between">
                  <span className="font-mono">{p.number}</span>
                  <span className="text-xs uppercase text-(--color-muted)">{p.provider}</span>
                </div>
                {p.label && <p className="text-xs text-(--color-muted)">{p.label}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {config.phone_numbers.length > 0 && (
        <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Place an outbound test call
          </h3>
          <label className="block text-xs text-(--color-muted)">From</label>
          <select
            value={selectedPhoneId}
            onChange={(e) => setSelectedPhoneId(e.target.value)}
            className="mt-1 w-full rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm"
          >
            {config.phone_numbers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.number}
              </option>
            ))}
          </select>
          <label className="mt-3 block text-xs text-(--color-muted)">To</label>
          <input
            type="tel"
            placeholder="+15551234567"
            value={toNumber}
            onChange={(e) => setToNumber(e.target.value)}
            className="mt-1 w-full rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm"
          />
          <button
            onClick={dial}
            disabled={dialing || !toNumber.trim()}
            className="mt-3 rounded-full bg-(--color-accent) px-4 py-2 text-sm font-semibold text-(--color-accent-foreground)"
          >
            {dialing ? "Dialing…" : "Call"}
          </button>
          {result && (
            <p className="mt-2 text-xs text-(--color-success)">{result}</p>
          )}
          {error && (
            <p className="mt-2 text-xs text-(--color-danger)">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
