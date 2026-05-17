/**
 * Firecrawl integration for scraping arbitrary websites into the agent's
 * knowledge base. Single-shot `crawl` with sensible defaults; the agent passes
 * a starting URL and optional limit. Returns the per-page markdown so the
 * caller can split it into separate KB documents.
 *
 * Docs: https://docs.firecrawl.dev/api-reference
 */

import { createLogger } from "@/lib/logger";

const log = createLogger("firecrawl");

export class FirecrawlError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set");
  return key;
}

export type ScrapedPage = {
  url: string;
  title: string;
  markdown: string;
};

export async function scrapePage(url: string): Promise<ScrapedPage> {
  const t0 = Date.now();
  log.info("scrape page", { url });
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
    }),
  });
  if (!res.ok) {
    log.error("scrape failed", { url, status: res.status, ms: Date.now() - t0 });
    throw new FirecrawlError(res.status, `Scrape failed (${res.status})`);
  }
  const json = (await res.json()) as {
    data: {
      markdown?: string;
      metadata?: { title?: string; sourceURL?: string };
    };
  };
  log.info("scrape ok", {
    url,
    ms: Date.now() - t0,
    bytes: json.data?.markdown?.length ?? 0,
  });
  return {
    url: json.data?.metadata?.sourceURL ?? url,
    title: json.data?.metadata?.title ?? url,
    markdown: json.data?.markdown ?? "",
  };
}

export async function crawlSite(input: {
  startUrl: string;
  limit?: number;
  includeOnlyPaths?: string[];
}): Promise<ScrapedPage[]> {
  log.info("crawl start", { startUrl: input.startUrl, limit: input.limit ?? 8 });
  const tStart = Date.now();
  const body = {
    url: input.startUrl,
    limit: input.limit ?? 8,
    scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    ...(input.includeOnlyPaths ? { includePaths: input.includeOnlyPaths } : {}),
  };
  const start = await fetch("https://api.firecrawl.dev/v1/crawl", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
  });
  if (!start.ok) {
    log.error("crawl start failed", { status: start.status });
    throw new FirecrawlError(start.status, `Crawl start failed (${start.status})`);
  }
  const { id } = (await start.json()) as { id: string };
  log.debug("crawl job started", { crawlId: id });

  // Poll until done (cap ~ 90 s)
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    const statusRes = await fetch(`https://api.firecrawl.dev/v1/crawl/${id}`, {
      headers: { authorization: `Bearer ${apiKey()}` },
    });
    if (!statusRes.ok) continue;
    const status = (await statusRes.json()) as {
      status: "scraping" | "completed" | "failed";
      data?: Array<{
        markdown?: string;
        metadata?: { title?: string; sourceURL?: string };
      }>;
    };
    if (status.status === "failed") {
      log.error("crawl failed", { crawlId: id, ms: Date.now() - tStart });
      throw new FirecrawlError(500, "Crawl failed");
    }
    if (status.status === "completed") {
      const pages = (status.data ?? []).map((d) => ({
        url: d.metadata?.sourceURL ?? input.startUrl,
        title: d.metadata?.title ?? d.metadata?.sourceURL ?? input.startUrl,
        markdown: d.markdown ?? "",
      }));
      log.info("crawl complete", {
        crawlId: id,
        pages: pages.length,
        ms: Date.now() - tStart,
      });
      return pages;
    }
  }
  log.error("crawl timeout", { crawlId: id, ms: Date.now() - tStart });
  throw new FirecrawlError(504, "Crawl timed out");
}
