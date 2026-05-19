import { elFetch } from "../core/fetch";

export type ElevenKbDoc = { id: string; name: string };

export async function createKbFromUrl(input: {
  url: string;
  name?: string;
}): Promise<ElevenKbDoc> {
  const res = await elFetch("/v1/convai/knowledge-base/url", {
    method: "POST",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: input.url, name: input.name ?? input.url }),
  });
  return (await res.json()) as ElevenKbDoc;
}

export async function createKbFromFile(input: {
  file: Blob;
  filename: string;
  name?: string;
}): Promise<ElevenKbDoc> {
  const form = new FormData();
  form.append("file", input.file, input.filename);
  if (input.name) form.append("name", input.name);
  const res = await elFetch("/v1/convai/knowledge-base/file", {
    method: "POST",
    section: "knowledge_base",
    body: form,
  });
  return (await res.json()) as ElevenKbDoc;
}

export async function createKbFromText(input: {
  text: string;
  name: string;
}): Promise<ElevenKbDoc> {
  const res = await elFetch("/v1/convai/knowledge-base/text", {
    method: "POST",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: input.text, name: input.name }),
  });
  return (await res.json()) as ElevenKbDoc;
}

export async function deleteKbDocument(documentId: string): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}`, {
    method: "DELETE",
    section: "knowledge_base",
  });
}

export async function renameKbDocument(
  documentId: string,
  name: string,
): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}`, {
    method: "PATCH",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/**
 * Fetch the indexed text content of a KB document. Used by the UI to
 * preview what the agent will actually see when this doc is retrieved.
 */
export async function getKbDocumentContent(
  documentId: string,
): Promise<{ content: string }> {
  const res = await elFetch(
    `/v1/convai/knowledge-base/${documentId}/content`,
    { method: "GET", section: "knowledge_base", headers: { accept: "text/plain" } },
  );
  const content = await res.text();
  return { content };
}

/**
 * Refresh a URL-based KB document — re-fetch from the source URL and
 * re-index. Useful when the upstream content changes.
 */
export async function refreshKbDocument(documentId: string): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}/refresh`, {
    method: "POST",
    section: "knowledge_base",
  });
}

/**
 * Explicitly run RAG indexing on a document. Documents are auto-indexed but
 * this lets the user trigger a re-index manually after content changes.
 */
export async function ragIndexKbDocument(
  documentId: string,
  model: string = "e5_mistral_7b_instruct",
): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}/rag-index`, {
    method: "POST",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
}

/**
 * Semantic search across the entire workspace knowledge base.
 * Returns the top-K matching chunks across documents.
 */
export async function searchKnowledgeBase(input: {
  query: string;
  agent_id?: string;
  document_ids?: string[];
  top_k?: number;
}): Promise<{
  results: Array<{
    document_id: string;
    document_name: string;
    chunk_id: string;
    content: string;
    score: number;
  }>;
}> {
  const res = await elFetch("/v1/convai/knowledge-base/search", {
    method: "POST",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: input.query,
      agent_id: input.agent_id,
      document_ids: input.document_ids,
      top_k: input.top_k ?? 5,
    }),
  });
  return (await res.json()) as {
    results: Array<{
      document_id: string;
      document_name: string;
      chunk_id: string;
      content: string;
      score: number;
    }>;
  };
}

/**
 * List the dependent agents currently referencing a KB document. Useful
 * before removing a document so we can warn the user it'll affect other
 * agents in the workspace.
 */
export async function getKbDependentAgents(
  documentId: string,
): Promise<{ agent_id: string; agent_name: string }[]> {
  const res = await elFetch(
    `/v1/convai/knowledge-base/${documentId}/dependent-agents`,
    { method: "GET", section: "knowledge_base" },
  );
  const json = (await res.json()) as {
    dependent_agents?: Array<{ agent_id: string; agent_name?: string }>;
  };
  return (json.dependent_agents ?? []).map((a) => ({
    agent_id: a.agent_id,
    agent_name: a.agent_name ?? a.agent_id,
  }));
}
