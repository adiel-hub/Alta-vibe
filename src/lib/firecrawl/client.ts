/**
 * Firecrawl integration for scraping arbitrary websites into the agent's
 * knowledge base. Single-shot `crawl` with sensible defaults; the agent passes
 * a starting URL and optional limit. Returns the per-page markdown so the
 * caller can split it into separate KB documents.
 *
 * Docs: https://docs.firecrawl.dev/api-reference
 */

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
    throw new FirecrawlError(res.status, `Scrape failed (${res.status})`);
  }
  const json = (await res.json()) as {
    data: {
      markdown?: string;
      metadata?: { title?: string; sourceURL?: string };
    };
  };
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
    throw new FirecrawlError(start.status, `Crawl start failed (${start.status})`);
  }
  const { id } = (await start.json()) as { id: string };

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
      throw new FirecrawlError(500, "Crawl failed");
    }
    if (status.status === "completed") {
      return (status.data ?? []).map((d) => ({
        url: d.metadata?.sourceURL ?? input.startUrl,
        title: d.metadata?.title ?? d.metadata?.sourceURL ?? input.startUrl,
        markdown: d.markdown ?? "",
      }));
    }
  }
  throw new FirecrawlError(504, "Crawl timed out");
}
