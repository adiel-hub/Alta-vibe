import { elFetch } from "../core/fetch";

export async function fetchConversationAudio(
  conversationId: string,
): Promise<Response> {
  return elFetch(`/v1/convai/conversations/${conversationId}/audio`, {
    method: "GET",
    section: "recording",
    headers: { accept: "audio/mpeg" },
  });
}
