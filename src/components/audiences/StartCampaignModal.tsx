"use client";

import { useEffect, useMemo, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";

type AgentOption = {
  id: string;
  name: string;
  phone_numbers: Array<{ id: string; number: string; label: string }>;
};

export function StartCampaignModal({
  audienceId,
  audienceName,
  dialable,
  onClose,
  onStarted,
}: {
  audienceId: string;
  audienceName: string;
  dialable: number;
  onClose: () => void;
  onStarted: (campaignId: string) => void;
}) {
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [phoneId, setPhoneId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch("/api/agents");
        const json = (await res.json().catch(() => ({}))) as {
          agents?: AgentOption[];
        };
        if (cancelled) return;
        const list = (json.agents ?? []).filter(
          (a) => a.phone_numbers.length > 0,
        );
        setAgents(list);
        if (list.length > 0) {
          setAgentId(list[0].id);
          setPhoneId(list[0].phone_numbers[0]?.id ?? "");
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load agents");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAgent = useMemo(
    () => agents?.find((a) => a.id === agentId) ?? null,
    [agents, agentId],
  );

  // When the agent changes, reset to its first phone number so the picker
  // never references a phone id from a different agent.
  useEffect(() => {
    if (!selectedAgent) return;
    if (!selectedAgent.phone_numbers.some((p) => p.id === phoneId)) {
      setPhoneId(selectedAgent.phone_numbers[0]?.id ?? "");
    }
  }, [selectedAgent, phoneId]);

  const submit = async () => {
    if (!agentId || !phoneId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch(`/api/audiences/${audienceId}/campaigns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          agent_phone_number_id: phoneId,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok || !json.id) {
        throw new Error(json.error ?? `Start failed (${res.status})`);
      }
      onStarted(json.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Start failed");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-(--color-border) bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-(--color-foreground-strong)">
          Start campaign
        </h2>
        <p className="mt-1 text-xs text-(--color-muted)">
          Sequential auto-dial through {dialable} prospect
          {dialable === 1 ? "" : "s"} in &ldquo;{audienceName}&rdquo;. Each
          call is placed via ElevenLabs.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-(--color-muted)">
              Agent
            </div>
            {agents === null ? (
              <div className="text-xs text-(--color-muted)">Loading…</div>
            ) : agents.length === 0 ? (
              <div className="rounded-md bg-(--color-panel-soft) px-3 py-2 text-xs text-(--color-muted)">
                No agents with a phone number attached. Add a phone to an
                agent first.
              </div>
            ) : (
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={busy}
                className="w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-sm"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </label>

          {selectedAgent && (
            <label className="block">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-(--color-muted)">
                Phone number
              </div>
              <select
                value={phoneId}
                onChange={(e) => setPhoneId(e.target.value)}
                disabled={busy}
                className="w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-sm font-mono"
              >
                {selectedAgent.phone_numbers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number}
                    {p.label ? ` — ${p.label}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {error && (
          <p className="mt-3 text-xs text-(--color-danger)">{error}</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={onClose}
            className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground-strong)"
          >
            Cancel
          </button>
          <Button
            disabled={busy || !agentId || !phoneId || dialable === 0}
            onClick={submit}
          >
            Start
          </Button>
        </div>
      </div>
    </div>
  );
}
