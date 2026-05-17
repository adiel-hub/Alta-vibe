import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  createKbFromText,
  createKbFromUrl,
  deleteKbDocument,
  patchAgent,
  renameKbDocument,
} from "@/lib/elevenlabs/client";
import { crawlSite, scrapePage } from "@/lib/firecrawl/client";
import type { KnowledgeBaseDocument } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

export const knowledgeBaseCapability: Capability = {
  id: "knowledge_base",
  label: "Knowledge base",
  defaultSlice: () => ({ knowledge_base: [] }),
  tools: (ctx) => [
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
          await patchAgent(ctx.elevenlabs_agent_id, {
            knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          });
          return {
            patch: { knowledge_base: next },
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
          await patchAgent(ctx.elevenlabs_agent_id, {
            knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          });
          return {
            patch: { knowledge_base: next },
            summary: `Added text snippet "${name}".`,
          };
        }),
    ),

    tool(
      "scrape_website_to_knowledge_base",
      "Crawl up to N pages from a starting URL and add each page as a separate knowledge base document. Use this when the user pastes a site URL or asks to index a docs/help section. Right panel fills in live, one page at a time.",
      {
        start_url: z.string().url(),
        limit: z.number().int().min(1).max(25).default(8),
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
          await patchAgent(ctx.elevenlabs_agent_id, {
            knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          });
          return {
            patch: { knowledge_base: next },
            summary: `Scraped ${created.length} page${created.length === 1 ? "" : "s"} into the knowledge base.`,
          };
        }),
    ),

    tool(
      "scrape_single_page_to_knowledge_base",
      "Scrape exactly one page and add it as a knowledge base document.",
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
          await patchAgent(ctx.elevenlabs_agent_id, {
            knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          });
          return {
            patch: { knowledge_base: next },
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
          await patchAgent(ctx.elevenlabs_agent_id, {
            knowledge_base: next.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          });
          await deleteKbDocument(document_id).catch(() => {});
          return {
            patch: { knowledge_base: next },
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
          return {
            patch: { knowledge_base: next },
            summary: `Renamed document to "${name}".`,
          };
        }),
    ),
  ],
};
