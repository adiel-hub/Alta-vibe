"use client";

import { useState } from "react";
import { useConversation } from "@elevenlabs/react";
import { appFetch } from "@/lib/apiClient";

export function TestCallTab({ agentId }: { agentId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [transcript, setTranscript] = useState<
    { role: "agent" | "user"; text: string }[]
  >([]);

  const conversation = useConversation({
    onError: (e: unknown) =>
      setError(typeof e === "string" ? e : "Conversation error"),
    onMessage: (msg: { message?: string; source?: string }) => {
      if (msg.message && msg.source) {
        setTranscript((t) => [
          ...t,
          {
            role: msg.source === "ai" ? "agent" : "user",
            text: msg.message ?? "",
          },
        ]);
      }
    },
  });

  const start = async () => {
    setError(null);
    setStarting(true);
    setTranscript([]);
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
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          Test by web call
        </h3>
        <p className="mb-4 text-sm text-(--color-muted)">
          Talk to your agent through the browser (WebRTC). Allow microphone access
          when prompted.
        </p>
        <div className="flex items-center gap-3">
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
          <div className="text-xs text-(--color-muted)">
            status: <span className="font-mono">{conversation.status}</span>
            {isActive && (
              <>
                {" · "}
                mode:{" "}
                <span className="font-mono">
                  {conversation.isSpeaking ? "agent" : "user"}
                </span>
              </>
            )}
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-(--color-danger)">{error}</p>}
      </div>

      {transcript.length > 0 && (
        <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Live transcript
          </h3>
          <div className="max-h-72 space-y-2 overflow-y-auto text-sm">
            {transcript.map((t, i) => (
              <p key={i}>
                <span
                  className={`mr-2 text-xs font-semibold uppercase ${
                    t.role === "agent"
                      ? "text-(--color-accent)"
                      : "text-(--color-foreground)"
                  }`}
                >
                  {t.role}
                </span>
                {t.text}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-dashed border-(--color-border) p-4 text-xs text-(--color-muted)">
        Want to test by phone instead? Open the <span className="font-semibold text-(--color-foreground)">Phone</span> tab,
        attach a number, and place an outbound call to your mobile.
      </div>
    </div>
  );
}
