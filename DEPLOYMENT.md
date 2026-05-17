# Deployment

Alta deploys in two pieces:

| Surface                            | Where     | Why                                                |
| ---------------------------------- | --------- | -------------------------------------------------- |
| Next.js app (UI + API routes)      | **Vercel** | Edge-cached UI, Node functions for the API        |
| MongoDB                            | **Railway** | Managed Mongo with backups + replica set         |
| *(optional)* Background worker     | **Railway** | Drains the `turn_jobs` queue when you outgrow Vercel `after()` |

The defaults — Vercel + Railway Mongo — work out of the box. The background
worker is an opt-in upgrade you flip on later once you're past the prototype.

---

## 1. Provision MongoDB on Railway

1. Sign in at https://railway.app and create a new project.
2. **+ New → Database → Add MongoDB**. Wait ~30 s for the instance to spin up.
3. Open the new MongoDB service → **Variables** → copy `MONGO_URL` (looks
   like `mongodb://mongo:PASSWORD@…/`).
4. (Optional but recommended) Open **Settings → Networking → Public
   Networking** and *enable* it. Without public networking, only services
   inside the same Railway project can connect — fine for the Railway
   worker later, but Vercel needs public access.
5. Keep the project open — we'll come back to set env vars on the app side.

Railway's managed MongoDB is a replica set by default, which means MongoDB
change streams work if you ever want to swap the worker's polling loop for
a watch cursor.

---

## 2. Deploy the Next.js app to Vercel

1. Push this repo to GitHub.
2. Go to https://vercel.com → **Add New → Project** → import the repo.
3. **Framework Preset**: Next.js (auto-detected).
4. **Root directory**: leave as `/`.
5. **Build & Output**: leave defaults (`next build`).
6. **Environment Variables** — add these and click "Deploy":

   | Name                            | Value                                     |
   | ------------------------------- | ----------------------------------------- |
   | `ANTHROPIC_API_KEY`             | your Anthropic key                        |
   | `ELEVENLABS_API_KEY`            | your voice-provider key                   |
   | `FIRECRAWL_API_KEY`             | your Firecrawl key                        |
   | `MONGODB_URI`                   | Railway's `MONGO_URL`                     |
   | `MONGODB_DB`                    | `alta_vibe`                               |
   | `APP_SHARED_SECRET`             | a long random string (e.g. `openssl rand -hex 32`) |
   | `NEXT_PUBLIC_APP_SHARED_SECRET` | same value as `APP_SHARED_SECRET`         |

7. After the first deploy, hit `https://<your-deployment>.vercel.app/api/health`.
   You should see `{"status":"ok","mongo":"ok",...}`.

### Vercel project settings worth flipping on

- **Pro plan**: enable **Fluid Compute**. Required for the chat/turn
  routes to use `maxDuration > 60 s`. Without it, long agent turns die at
  60 s and the stuck-job watchdog fires.
- **Functions → Region**: pin to `iad1` (US East) or wherever your Mongo
  lives. `vercel.json` already sets this to `iad1`; change there if you
  picked a different Railway region.
- **Build settings → Node.js version**: 22.x (matches `package.json` engines).

### What's already wired

- `vercel.json` sets the regions, sane security headers
  (X-Frame-Options, HSTS, Referrer-Policy, etc.), and disables caching/buffering
  on the SSE stream route.
- The auth gate in `src/lib/auth.ts` fails closed in production if
  `APP_SHARED_SECRET` is missing.
- `next.config.ts` marks heavy server packages as
  `serverExternalPackages` so they aren't bundled into the function.

---

## 3. (Optional) Add the Railway background worker

You only need this once Vercel's per-request `after()` window stops being
enough — typically when turns regularly run > 5 minutes, or when you start
processing dozens of turns in parallel.

The worker drains the same `turn_jobs` queue Vercel writes to.
`processTurnJob` has an atomic claim so it's safe to run the worker
alongside Vercel `after()` — whichever picks up a queued job first wins.

1. In the same Railway project, **+ New → GitHub Repo** → select this repo.
2. **Settings → Source**: leave `/` as the root.
3. **Settings → Build**: Railway auto-detects Node via `railway.json`
   (uses Nixpacks). No changes needed.
4. **Settings → Deploy → Start Command**: leave the default. The repo's
   `railway.json` already sets `npx tsx scripts/worker.ts`.
5. **Variables** — set the same secrets:

   | Name                            | Notes                                                |
   | ------------------------------- | ---------------------------------------------------- |
   | `ANTHROPIC_API_KEY`             | required                                             |
   | `ELEVENLABS_API_KEY`            | required                                             |
   | `FIRECRAWL_API_KEY`             | required for KB scraping                             |
   | `MONGODB_URI`                   | inside Railway you can reference `${{MongoDB.MONGO_URL}}` |
   | `MONGODB_DB`                    | `alta_vibe`                                          |
   | `WORKER_MAX_CONCURRENT`         | default `4` — concurrent jobs per worker             |
   | `WORKER_POLL_INTERVAL_MS`       | default `1000`                                       |

6. The worker will start, print `[worker] starting · maxConcurrent=…` to
   the logs, and begin draining queued jobs. To verify: trigger a chat
   turn from the app, then watch the Railway logs.

You can run multiple instances of the worker for horizontal scale —
Railway → **Settings → Replicas**. The atomic Mongo claim guarantees no
double-processing.

### Disabling Vercel `after()` when the worker is on

By default both paths run. If you want Vercel to STOP firing
`after(processTurnJob)` and let the worker do all the heavy lifting (so
your Vercel functions return in tens of ms), set:

```
USE_RAILWAY_WORKER=true
```

on Vercel. The chat route still enqueues; the worker picks up. (This
flag isn't wired into a code path yet — flip the `after()` call to a
no-op behind `process.env.USE_RAILWAY_WORKER` when you're ready.)

---

## 4. First-time smoke test

1. Open the Vercel URL.
2. Type "A bakery receptionist who takes phone orders." → **Continue**.
3. You should land on `/agents/<id>` and immediately see Alta starting
   to build the agent (workflow nodes appearing, voice being chosen).
4. In the right panel, watch the Workflow, Voice, and Knowledge tabs
   light up in real time.
5. Refresh mid-turn — the chat re-attaches and you see the rest of the
   turn complete.
6. Open the Test tab → **Start call** → talk to the agent in the browser.
   Workflow nodes light up live as the conversation transitions.

If `/api/health` returns 503 with `mongo: error`, your `MONGODB_URI`
is wrong or Railway's public networking is off.

---

## Cost notes

- **Vercel**: Hobby plan works for development but you'll want **Pro**
  for production — Fluid Compute + 800 s function durations are
  required for long Claude turns.
- **Railway**: a `Hobby` plan ($5/mo) hosts both MongoDB and the
  worker comfortably for low traffic.
- **ElevenLabs / Anthropic / Firecrawl**: pay-as-you-go; budget the
  usual third-party-API costs.

---

## Troubleshooting

- **`Unauthorized` on every API call**: `APP_SHARED_SECRET` set on the
  server but the browser-side `NEXT_PUBLIC_APP_SHARED_SECRET` is missing
  or doesn't match. They must be identical.
- **Chat hangs after first message**: probably hit a Vercel timeout.
  Confirm Fluid Compute is on. If you're on Hobby (60 s cap), turns that
  involve Firecrawl crawls will time out — add the Railway worker.
- **Voice list empty in the right panel**: `ELEVENLABS_API_KEY` is
  invalid or out of quota.
- **Workflow tab empty**: Alta hasn't built one yet. The first turn
  triggers it; if the first turn errored, check `/api/health`, then the
  chat for an error pill.
