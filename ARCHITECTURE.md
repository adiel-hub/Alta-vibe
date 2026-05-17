# Architecture

A senior-level map of Alta. The product is a "vibe-code your voice agent"
platform: the user describes an agent in chat, an AI co-pilot (Claude
Agent SDK) calls capability tools to configure a real voice agent in
real time, the right panel reflects every change, and the user can test
the agent by web or phone with the workflow lighting up live.

---

## Top-level shape

```
Next.js 16 (App Router)
├─ Pages
│   ├─ /                  Landing — "Describe your voice agent"
│   └─ /agents/[id]       Split builder (Chat ⇆ Visual panel)
└─ API routes (all gated by x-app-secret)
    ├─ /api/agents              POST create
    ├─ /api/agents/[id]         GET (freshened from provider)
    ├─ /api/agents/[id]/config  PATCH (direct UI edits)
    ├─ /api/agents/[id]/chat    POST → enqueues a turn job, returns {jobId}
    ├─ /api/agents/[id]/turns/active            GET active job (+ reaps stuck)
    ├─ /api/agents/[id]/turns/[jobId]/stream    SSE tail of one turn
    ├─ /api/agents/[id]/widgets/[actionId]      GET status
    ├─ /api/agents/[id]/widgets/[actionId]/resolve POST resolution
    ├─ /api/agents/[id]/knowledge-base/file     POST multipart upload
    ├─ /api/agents/[id]/knowledge-base/[docId]  PATCH rename · DELETE remove
    ├─ /api/agents/[id]/outbound-call           POST place a call
    ├─ /api/agents/[id]/conversation-token      GET signed url for WebRTC
    ├─ /api/agents/[id]/calls / [callId] / audio  Call log read APIs
    └─ /api/voices                              GET voice catalog
```

---

## The capability registry

The core architectural seam. Everything an agent can DO is a
**capability** — a self-contained module under `src/lib/capabilities/`:

```ts
type Capability = {
  id: string;                                 // unique slug
  label: string;                              // human-readable
  tools: (ctx: ToolContext) => SdkTool[];     // builder MCP tools
  defaultSlice: () => Partial<AgentConfigCache>; // default state
};
```

Add a new feature = drop in one file and register it in
`capabilities/index.ts`. There is nothing else to touch:

- `builder-agent/tools.ts` flattens `CAPABILITIES.flatMap(c => c.tools(ctx))`
  into the single MCP server passed to the Claude Agent SDK.
- `defaultAgentConfig()` merges every capability's `defaultSlice()` to seed
  new agents.
- The right panel renders tabs; section keys for spinners/errors come from
  capability ids.

Capabilities shipping today:

| id                  | role                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `identity`          | name, first_message, system_prompt                                |
| `voice`             | voice, voice_settings, tts_model, language                        |
| `llm`               | LLM model, temperature, max call duration                         |
| `knowledge_base`    | URL/text/file adds, Firecrawl crawl + scrape, rename, remove      |
| `runtime_tools`     | `create_custom_runtime_tool` (phase = pre / in / post), remove    |
| `mcp`               | Add/remove external MCP servers                                   |
| `post_call_analysis`| Data collection fields, evaluation criteria                       |
| `telephony`         | Phone number listing/assignment, outbound calls, call logs        |
| `workflow`          | Conversation graph builder (nodes + edges)                        |
| `workflow_tracking` | Registers the client tool for live test-call node highlighting    |
| `widgets`           | `request_user_action` for interactive chat widgets                |
| `integrations`      | Disconnect provider; introspect connected ones                    |

Tool handlers use `runToolStep(ctx, section, op, fn)` — a guarded executor
that catches all errors, emits `state_error` events for the UI, and returns
agent-visible `tool_result` with `is_error: true` so the Claude loop self-
corrects. Validation lives in each tool's Zod schema; failures roll back
into the loop as well, so the agent never crashes out — it iterates.

---

## Refresh-safe agent turns

Turns are background jobs. The HTTP request that triggers a turn only
enqueues it.

```
Browser POST /chat ─► creates turn_jobs row, returns {jobId}
                     │
                     └─ after()/waitUntil ─► processTurnJob(jobId)
                                                │
                                                ├─ runs Claude Agent SDK
                                                ├─ pushes events to turn_jobs.events
                                                ├─ persists assistant turn
                                                └─ commits config_cache + revision

Browser EventSource GET /turns/[jobId]/stream
   replays events since seq=0, polls Mongo at 250 ms intervals,
   closes when status terminal.
```

Refresh-safety: any seq can be re-tailed. On page mount the chat panel
calls `/turns/active` (which first reaps any job idle > 90 s — the stuck-job
watchdog) and auto-attaches to a running one. The user returns to the same
streaming state.

---

## Workflow as first-class state

`config_cache.workflow` is a graph (`nodes[]`, `edges[]`). Builder tools
mutate it; the right panel renders a topologically-laid-out SVG that
updates live via `state_patch` events.

Every workflow change automatically appends a `--- WORKFLOW ---` section
to the deployed agent's system prompt, so the agent at runtime follows the
graph.

**Live highlighting during test calls:** the `workflow_tracking` capability
registers a `report_workflow_state` *client* tool on the deployed agent.
When the agent (running inside the voice provider) crosses into a node it
invokes this tool over WebRTC; the browser SDK's `useConversation
({ clientTools })` handler updates `liveWorkflowNodeId` in Zustand and the
visualizer fills the matching node with the accent color.

---

## Interactive chat widgets

`request_user_action` builder tool → creates a `widget_actions` row →
emits `widget_inserted` SSE event → chat panel renders the matching
`<ChatWidget>` (Connect / Confirm / Pick).

When the user clicks: `POST /widgets/[actionId]/resolve`:

1. Marks the action `done`
2. Runs side-effect (e.g. `registerProviderForAgent(hubspot)` which
   creates that provider's runtime tools on the agent)
3. Inserts a synthetic SYSTEM chat message describing what happened
4. Enqueues a new turn job so the Claude loop continues with the result

This is how the agent "stays in its loop" across a human pause.

---

## Integrations

`src/lib/integrations/providers.ts` is the only place that knows what a
provider IS. Each entry declares oauth metadata + the runtime_tools to
auto-register on the agent when connected. Adding HubSpot Calendar /
Stripe / Salesforce / a custom thing = one entry in `PROVIDERS`.

Connect flow goes through the widget capability — there's no
provider-specific UI. The widget shows a Connect button; on success the
side-effect helper (`registerProviderForAgent`) creates each declared
runtime tool on the deployed agent and adds a `ConnectedIntegration` to
`config_cache.integrations`.

OAuth itself is stubbed in this codebase (returns mocked credentials so
the flow is testable). Real OAuth = add `/api/integrations/[provider]/
callback` per provider; the same `registerProviderForAgent` finalizes
the wiring.

---

## Mongo collections

| Collection         | Purpose                                                              | Key indexes                                         |
| ------------------ | -------------------------------------------------------------------- | --------------------------------------------------- |
| `agents`           | One per voice agent; holds `config_cache` projection + `revision`    | `elevenlabs_agent_id` unique                        |
| `chat_messages`    | Append-only transcript with verbatim Anthropic content blocks        | `(agent_id, created_at)`                            |
| `turn_jobs`        | Background-runner state per turn (`events[]`, `last_event_at`, ...)   | `(agent_id, started_at desc)`, `(status, last_event_at)` |
| `widget_actions`   | Pending/resolved interactive widget rows                              | `(agent_id, status, created_at desc)`               |
| `integrations`     | Connected provider credentials                                        | `(agent_id, provider)` unique                       |

`agents.config_cache` is a projection. Provider is source of truth; we
re-fetch on read and write the latest projection back. Monotonic
`revision` provides optimistic concurrency.

---

## SSE event protocol

```
assistant_delta     { text }                            // partial text deltas
tool_call_start     { tool_use_id, name, input }
tool_call_result    { tool_use_id, output, is_error? }
state_patch         { revision, patch: Partial<config> }
widget_inserted     { action_id, kind, payload }
widget_resolved     { action_id, status, result }
state_error         { section, message }
turn_aborted        { reason }
turn_done           { revision }
```

Server tags every event with `id: <seq>` so clients can re-tail from any
seq. Revisions monotonic; client refetches `GET /api/agents/[id]` if it
ever sees a gap.

---

## Adding a new feature — the cheat sheet

| Want to add…                          | Touch…                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| A new builder tool                    | `src/lib/capabilities/<area>.ts` (or a new file + index.ts) |
| A new state field                     | `AgentConfigCache` in `types/agent.ts` + capability slice    |
| A new right-panel tab                 | `components/builder/tabs/Xxx.tsx` + register in VisualPanel  |
| A new third-party integration         | one entry in `src/lib/integrations/providers.ts`             |
| A new interactive widget kind         | a Zod payload schema in `capabilities/widgets.ts` + a renderer branch in `ChatWidget.tsx` |
| A new SSE event type                  | extend `SSEEvent` union, handle in `store/sseClient.ts`      |
| A new collection                      | add to `src/lib/mongodb.ts` (helper + index)                 |

Most features fit in one file; everything else is convention.
