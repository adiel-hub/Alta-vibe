import { useState } from "react";
import { sendMessage } from "@/store/sseClient";
import { Button } from "@/components/ui/Button";

export function ConnectProviderButton({
  agentId,
  providerName,
}: {
  agentId: string;
  providerName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      // Ask the builder agent to walk the user through OAuth/PAT — this is the
      // same flow as typing "Connect <Provider>" in chat, which the agent
      // answers with a connect_integration widget.
      await sendMessage(agentId, `Connect ${providerName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-[11px] text-(--color-danger)">{error}</span>
      )}
      <Button size="sm" disabled={busy} onClick={onConnect}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}
