"use client";

import { useState } from "react";
import { useConversation } from "@elevenlabs/react";
import { appFetch } from "@/lib/apiClient";

export function TestCallTab({ agentId }: { agentId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const conversation = useConversation({
    onError: (e) => setError(typeof e === "string" ? e : "Conversation error"),
  });

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const tokenRes = await appFetch(`/api/agents/${agentId}/conversation-token`);
      if (!tokenRes.ok) throw new Error(`Token failed (${tokenRes.status})`);
      const json = (await tokenRes.json()) as { signed_url: string };
      await conversation.startSession({ signedUrl: json.signed_url });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start session");
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    await conversation.endSession();
  };

  const isActive = conversation.status === "connected";

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          Test call
        </h3>
        <p className="mb-4 text-sm text-(--color-muted)">
          Talk to your agent in the browser. WebRTC; allow microphone access.
        </p>
        {!isActive ? (
          <button
            onClick={start}
            disabled={starting}
            className="rounded-full bg-(--color-accent) px-5 py-2 text-sm font-semibold text-(--color-accent-foreground)"
          >
            {starting ? "Connecting…" : "Start call"}
          </button>
        ) : (
          <button
            onClick={stop}
            className="rounded-full border border-(--color-danger) px-5 py-2 text-sm font-semibold text-(--color-danger)"
          >
            End call
          </button>
        )}
        <div className="mt-4 text-xs text-(--color-muted)">
          status: <span className="font-mono">{conversation.status}</span> ·
          mode: <span className="font-mono">{conversation.isSpeaking ? "agent" : "user"}</span>
        </div>
        {error && (
          <p className="mt-2 text-xs text-(--color-danger)">{error}</p>
        )}
      </div>
    </div>
  );
}
