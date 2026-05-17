# Alta

A "vibe-code your voice agent" platform. Type a one-paragraph description of
the agent you want; Alta — a Claude-powered co-pilot — builds it for you by
calling tools that shape the real voice agent in real time. The right
panel reflects every change as it happens (workflow graph, voice, knowledge,
runtime tools, phone, call logs). Test the agent by web call or phone with
the workflow lighting up live.

## Quick start (local)

```bash
git clone <repo>
cd Alta-vibe
npm install
cp .env.example .env.local       # fill in keys
npm run dev                       # open http://localhost:3000
```

Required env vars: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`,
`FIRECRAWL_API_KEY`, `MONGODB_URI`, `MONGODB_DB`, plus
`APP_SHARED_SECRET` + `NEXT_PUBLIC_APP_SHARED_SECRET` (matched).

## Deploying

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full Vercel + Railway
walkthrough. Tldr:

1. Provision MongoDB on Railway, copy the connection string.
2. Import this repo into Vercel, paste the env vars, deploy.
3. (Optional, when you outgrow Vercel `after()`) deploy the
   `scripts/worker.ts` background worker as a second Railway service.

## Architecture

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the system map. One-line
summary: every feature is a self-contained **capability** module under
`src/lib/capabilities/` exposing `tools(ctx)` + `defaultSlice()`. Adding a
new tool, integration, or workflow node type is one file.

## Layout

```
src/
├── app/                    Next.js App Router (UI + API routes)
├── components/builder/     Right-panel tabs + chat widgets
├── lib/
│   ├── capabilities/       Identity, voice, kb, workflow, widgets, … (the seam)
│   ├── elevenlabs/         Voice-provider HTTP client (one place, never leaked to UI)
│   ├── firecrawl/          Web-scrape client for KB crawls
│   ├── integrations/       Provider registry + tool-registration side effect
│   ├── builder-agent/      Claude Agent SDK orchestration + system prompt
│   └── turn-jobs/          Background turn runner (refresh-safe streaming)
├── store/                  Zustand store + SSE client
└── types/                  Shared TS types
scripts/
└── worker.ts               Optional Railway worker that drains turn_jobs
```

## Commands

| Command              | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `npm run dev`        | Next.js dev server on :3000                           |
| `npm run build`      | Production build                                      |
| `npm run start`      | Run the production build                              |
| `npm run typecheck`  | TypeScript-only check (no emit)                       |
| `npm run lint`       | Next.js lint                                          |
| `npm run worker`     | Railway worker locally (drains turn_jobs from Mongo)  |
