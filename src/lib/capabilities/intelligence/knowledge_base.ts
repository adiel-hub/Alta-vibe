import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  createKbFromText,
  createKbFromUrl,
  deleteKbDocument,
  getKbDependentAgents,
  ragIndexKbDocument,
  refreshKbDocument,
  renameKbDocument,
  searchKnowledgeBase,
} from "@/lib/elevenlabs/client";
import { crawlSite, scrapePage } from "@/lib/firecrawl/client";
import type { KnowledgeBaseDocument } from "@/types/agent";
import type { Capability } from "../types";
import { runToolStep } from "../types";

/** Shape we attach knowledge-base docs in on the upstream PATCH (drops `source`). */
function toUpstreamKb(docs: KnowledgeBaseDocument[]) {
  return docs.map((d) => ({ id: d.id, name: d.name, type: d.type }));
}

export const knowledgeBaseCapability: Capability = {
  id: "knowledge_base",
  label: "Knowledge base",
  defaultSlice: () => ({ knowledge_base: [] }),
  tools: (ctx) => [
    tool(
      "read_website",
      "Scrape a page and RETURN its text in the tool result — does NOT add it to the knowledge base. Use this early in a build to learn what a brand/product does so you can write a tailored Persona, Workflow, and (later) a curated KB document. For raw indexing prefer scrape_single_page_to_knowledge_base.",
      { url: z.string().url(), max_chars: z.number().int().min(500).max(20_000).default(8_000) },
      async ({ url, max_chars }) =>
        runToolStep(ctx, "knowledge_base", "read_website", async () => {
          const page = await scrapePage(url);
          const text =
            (page.markdown || page.title || "").trim().slice(0, max_chars) ||
            "(empty page)";
          return {
            patch: {},
            // Inline the scraped content into the summary so the agent sees
            // it in its tool_result without us having to widen runToolStep.
            summary: `Source: ${url}\n\n${text}`,
          };
        }),
    ),

    tool(
      "add_knowledge_base_url",
      "Index a single URL into the agent's knowledge base for RAG.",
      { url: z.string().url(), name: z.string().optional() },
      async ({ url, name }) =>
        runToolStep(ctx, "knowledge_base", "add_knowledge_base_url", async () => {
          const doc = await createKbFromUrl({ url, name });
          const entry: KnowledgeBaseDocument = {
            id: doc.id,
            name: doc.name,
            type: "url",
            source: url,
          };
          const next = [...ctx.config.knowledge_base, entry];
          return {
            patch: { knowledge_base: next },
            upstreamPatch: { knowledge_base: toUpstreamKb(next) },
            summary: `Added "${doc.name}" to the knowledge base.`,
          };
        }),
    ),

    tool(
      "add_knowledge_base_text",
      "Add an arbitrary text snippet to the knowledge base.",
      { name: z.string().min(1), text: z.string().min(10) },
      async ({ name, text }) =>
        runToolStep(ctx, "knowledge_base", "add_knowledge_base_text", async () => {
          const doc = await createKbFromText({ name, text });
          const entry: KnowledgeBaseDocument = {
            id: doc.id,
            name: doc.name,
            type: "text",
            source: "text",
          };
          const next = [...ctx.config.knowledge_base, entry];
          return {
            patch: { knowledge_base: next },
            upstreamPatch: { knowledge_base: toUpstreamKb(next) },
            summary: `Added text snippet "${name}".`,
          };
        }),
    ),

    tool(
      "scrape_website_to_knowledge_base",
      "SLOW — only use when the user explicitly asks to index an entire site / docs section. Crawls up to N pages (default 3, keep small). For a single URL prefer scrape_single_page_to_knowledge_base.",
      {
        start_url: z.string().url(),
        limit: z.number().int().min(1).max(25).default(3),
      },
      async ({ start_url, limit }) =>
        runToolStep(ctx, "knowledge_base", "scrape_website", async () => {
          const pages = await crawlSite({ startUrl: start_url, limit });
          const created: KnowledgeBaseDocument[] = [];
          for (const page of pages) {
            if (!page.markdown || page.markdown.length < 50) continue;
            const name = (page.title || page.url).slice(0, 120);
            const doc = await createKbFromText({
              name,
              text: `Source: ${page.url}\n\n${page.markdown}`,
            });
            created.push({
              id: doc.id,
              name: doc.name,
              type: "text",
              source: page.url,
            });
            const incremental = [...ctx.config.knowledge_base, ...created];
            ctx.emit({
              type: "state_patch",
              revision: ctx.bumpRevision(),
              patch: { knowledge_base: incremental },
            });
            ctx.config.knowledge_base = incremental;
          }
          const next = ctx.config.knowledge_base;
          return {
            patch: { knowledge_base: next },
            upstreamPatch: { knowledge_base: toUpstreamKb(next) },
            summary: `Scraped ${created.length} page${created.length === 1 ? "" : "s"} into the knowledge base.`,
          };
        }),
    ),

    tool(
      "scrape_single_page_to_knowledge_base",
      "PREFERRED for website URLs. Scrapes exactly one page (fast — a few seconds) and adds it as a knowledge base document. Default choice when the user gives you a website URL; only escalate to scrape_website_to_knowledge_base if they ask to index a whole site.",
      { url: z.string().url() },
      async ({ url }) =>
        runToolStep(ctx, "knowledge_base", "scrape_single_page", async () => {
          const page = await scrapePage(url);
          if (!page.markdown) throw new Error("Empty scrape result");
          const doc = await createKbFromText({
            name: (page.title || page.url).slice(0, 120),
            text: `Source: ${page.url}\n\n${page.markdown}`,
          });
          const entry: KnowledgeBaseDocument = {
            id: doc.id,
            name: doc.name,
            type: "text",
            source: page.url,
          };
          const next = [...ctx.config.knowledge_base, entry];
          return {
            patch: { knowledge_base: next },
            upstreamPatch: { knowledge_base: toUpstreamKb(next) },
            summary: `Scraped "${doc.name}".`,
          };
        }),
    ),

    tool(
      "remove_knowledge_base_document",
      "Detach a document and delete it from the workspace.",
      { document_id: z.string().min(1) },
      async ({ document_id }) =>
        runToolStep(ctx, "knowledge_base", "remove_kb_doc", async () => {
          if (!ctx.config.knowledge_base.some((d) => d.id === document_id)) {
            throw new Error(
              `No document with id "${document_id}" in the knowledge base. Call list to inspect ids.`,
            );
          }
          const next = ctx.config.knowledge_base.filter((d) => d.id !== document_id);
          await deleteKbDocument(document_id).catch(() => {});
          return {
            patch: { knowledge_base: next },
            upstreamPatch: { knowledge_base: toUpstreamKb(next) },
            summary: "Knowledge base document removed.",
          };
        }),
    ),

    tool(
      "rename_knowledge_base_document",
      "Rename a knowledge base document.",
      { document_id: z.string().min(1), name: z.string().min(1).max(120) },
      async ({ document_id, name }) =>
        runToolStep(ctx, "knowledge_base", "rename_kb_doc", async () => {
          if (!ctx.config.knowledge_base.some((d) => d.id === document_id)) {
            throw new Error(`No document with id "${document_id}".`);
          }
          await renameKbDocument(document_id, name);
          const next = ctx.config.knowledge_base.map((d) =>
            d.id === document_id ? { ...d, name } : d,
          );
          // Renaming a KB doc is a doc-level op upstream; the agent's
          // `knowledge_base` list still references the same id, so no agent
          // PATCH is needed. We update local cache only.
          return {
            patch: { knowledge_base: next },
            summary: `Renamed document to "${name}".`,
          };
        }),
    ),

    tool(
      "refresh_knowledge_base_document",
      "Re-fetch a URL-based document from its source and re-index. Useful when upstream content changes (docs updates, FAQ edits, etc.).",
      { document_id: z.string().min(1) },
      async ({ document_id }) =>
        runToolStep(ctx, "knowledge_base", "refresh_kb_doc", async () => {
          await refreshKbDocument(document_id);
          return { patch: {}, summary: "Document refreshed from source." };
        }),
    ),

    tool(
      "rag_index_knowledge_base_document",
      "Force a fresh RAG index pass on a document. Documents are auto-indexed on add, but call this if you've tuned the embedding model or noticed missed retrievals.",
      {
        document_id: z.string().min(1),
        embedding_model: z.string().optional(),
      },
      async ({ document_id, embedding_model }) =>
        runToolStep(ctx, "knowledge_base", "rag_index_kb_doc", async () => {
          await ragIndexKbDocument(document_id, embedding_model);
          return { patch: {}, summary: "Document re-indexed for RAG." };
        }),
    ),

    tool(
      "search_knowledge_base",
      "Run a semantic search across the knowledge base. Returns the top matching chunks with document name, content, and similarity score. Use this to verify whether a topic is covered before the user asks.",
      {
        query: z.string().min(2).max(500),
        top_k: z.number().int().min(1).max(20).default(5),
      },
      async ({ query, top_k }) => {
        try {
          const result = await searchKnowledgeBase({
            query,
            agent_id: ctx.elevenlabs_agent_id,
            top_k,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              { type: "text" as const, text: `search_knowledge_base failed: ${message}` },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "list_kb_document_dependent_agents",
      "Before removing a document, see which other agents in the workspace also use it. Returns a list of dependent agent ids.",
      { document_id: z.string().min(1) },
      async ({ document_id }) => {
        try {
          const deps = await getKbDependentAgents(document_id);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(deps) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              { type: "text" as const, text: `list_kb_dependent_agents failed: ${message}` },
            ],
            isError: true,
          };
        }
      },
    ),
  ],
};
