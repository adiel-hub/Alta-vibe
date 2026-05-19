"use client";

import { useEffect, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { ChevronLeftIcon } from "./icons/ChevronLeftIcon";

// ── Outbound dial form (shown inside the dropdown) ───────────────────────

export function OutboundForm({
  agentId,
  onBack,
  onSuccess,
}: {
  agentId: string;
  onBack: () => void;
  onSuccess: () => void;
}) {
  const config = useAgentStore((s) => s.config);
  const phoneNumbers = config?.phone_numbers ?? [];
  const [selectedPhoneId, setSelectedPhoneId] = useState<string>(
    phoneNumbers[0]?.id ?? "",
  );
  const [toNumber, setToNumber] = useState("");
  const [dialing, setDialing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedPhoneId && phoneNumbers[0]?.id) {
      setSelectedPhoneId(phoneNumbers[0].id);
    }
  }, [phoneNumbers, selectedPhoneId]);

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
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Call failed (${res.status})`);
      }
      setResult("Call placed.");
      // Close after a beat so the operator sees confirmation.
      window.setTimeout(onSuccess, 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Call failed");
    } finally {
      setDialing(false);
    }
  };

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-6 w-6 place-items-center rounded text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
        >
          <ChevronLeftIcon />
        </button>
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-muted)">
          Outbound call
        </h3>
      </div>

      {phoneNumbers.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-(--color-muted)">
          No phone numbers attached. Ask in chat to attach one.
        </p>
      ) : (
        <div className="space-y-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-(--color-muted-soft)">
              From
            </label>
            <select
              value={selectedPhoneId}
              onChange={(e) => setSelectedPhoneId(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-2.5 py-1.5 text-xs"
            >
              {phoneNumbers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-(--color-muted-soft)">
              To
            </label>
            <input
              type="tel"
              placeholder="+15551234567"
              value={toNumber}
              onChange={(e) => setToNumber(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-2.5 py-1.5 text-xs"
            />
          </div>
          <Button
            block
            size="sm"
            onClick={dial}
            disabled={dialing || !toNumber.trim()}
          >
            {dialing ? "Dialing…" : "Call"}
          </Button>
          {result && (
            <p className="text-[11px] text-(--color-success)">{result}</p>
          )}
          {error && (
            <p className="text-[11px] text-(--color-danger)">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
