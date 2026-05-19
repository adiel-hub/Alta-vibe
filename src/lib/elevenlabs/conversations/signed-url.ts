import { elFetch } from "../core/fetch";

export async function getConversationSignedUrl(
  agentId: string,
): Promise<{ signed_url: string }> {
  const res = await elFetch(
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { method: "GET", section: "conversation_token" },
  );
  return (await res.json()) as { signed_url: string };
}
