/**
 * Phase-0 spike: probe the ElevenLabs real-time monitoring WebSocket.
 *
 * Connects to a LIVE conversation's monitor socket and logs every event it
 * emits — the distinct `type`s, full payloads, and (loudly) any field that
 * looks like it carries a workflow node / sub-agent id. The output decides
 * whether live node-tracking can read an exact node from the stream
 * (Approach B) or must be inferred client-side (Approach A).
 *
 * Browsers can't open this socket directly — the WHATWG WebSocket can't set
 * the required `xi-api-key` header — so this runs in Node with the `ws`
 * package, which can.
 *
 * Usage:
 *   1. Start a Web test call in the builder; copy the conversation_id that
 *      prints to the browser console ("web call connected").
 *   2. While the call is still active, run:
 *        npx tsx --env-file=.env.local scripts/monitor-probe.ts <conversation_id>
 *   3. Talk through a workflow that has a conversational node, a tool node,
 *      and (if possible) a transfer node. Ctrl+C to stop and print the
 *      event histogram.
 *
 * Note: the conversation must already be active — you cannot monitor before
 * it begins (per ElevenLabs docs).
 */
import WebSocket from "ws";

const BASE_WS = "wss://api.elevenlabs.io/v1/convai/conversations";
// Keys that, if present anywhere in a payload, would let us track the active
// node EXACTLY instead of inferring it.
const NODE_HINT_RE = /node|workflow|sub.?agent|agent_id|transition|current|phase|state/i;

function fail(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const conversationId = process.argv[2];
if (!conversationId) {
  fail("Missing <conversation_id>. Usage: tsx scripts/monitor-probe.ts <conversation_id>");
}

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  fail("ELEVENLABS_API_KEY not set. Run with: npx tsx --env-file=.env.local scripts/monitor-probe.ts <id>");
}

const url = `${BASE_WS}/${conversationId}/monitor`;
console.log(`\n→ connecting to ${url}\n`);

const counts = new Map<string, number>();
/** Records every (eventType, dotted.key.path) pair that matched NODE_HINT_RE. */
const nodeHints = new Map<string, Set<string>>();
let total = 0;

/** Recursively collect dotted key paths whose key OR string value smells like a node ref. */
function scanForNodeHints(obj: unknown, path: string, hits: Set<string>): void {
  if (obj == null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    if (NODE_HINT_RE.test(k)) hits.add(`${here} = ${JSON.stringify(v)?.slice(0, 120)}`);
    else if (typeof v === "string" && NODE_HINT_RE.test(v)) hits.add(`${here} (value) = ${v.slice(0, 120)}`);
    if (typeof v === "object") scanForNodeHints(v, here, hits);
  }
}

const ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });

ws.on("open", () => {
  console.log("✓ connected — listening for events (Ctrl+C to stop)\n");
});

ws.on("message", (raw: WebSocket.RawData) => {
  total += 1;
  let evt: unknown;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    console.log("⚠ non-JSON message:", raw.toString().slice(0, 200));
    return;
  }
  const type = (evt as { type?: string })?.type ?? "(no type)";
  counts.set(type, (counts.get(type) ?? 0) + 1);

  const hits = new Set<string>();
  scanForNodeHints(evt, "", hits);
  if (hits.size) {
    const set = nodeHints.get(type) ?? new Set<string>();
    hits.forEach((h) => set.add(h));
    nodeHints.set(type, set);
  }

  const banner = hits.size ? "  ⭐ NODE-HINT" : "";
  console.log(`#${total} [${type}]${banner}`);
  console.log(JSON.stringify(evt, null, 2));
  if (hits.size) {
    console.log("  ⭐ matched keys:");
    hits.forEach((h) => console.log(`     - ${h}`));
  }
  console.log("");
});

ws.on("error", (err) => console.error("✖ socket error:", err.message));

ws.on("close", (code, reason) => {
  console.log(`\n✗ closed (code ${code}) ${reason?.toString() || ""}`);
  printSummary();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n— interrupted —");
  try {
    ws.close();
  } catch {
    /* */
  }
  printSummary();
  process.exit(0);
});

function printSummary(): void {
  console.log("\n========== EVENT HISTOGRAM ==========");
  if (counts.size === 0) {
    console.log("(no events received)");
  } else {
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([t, n]) => console.log(`  ${n.toString().padStart(4)}  ${t}`));
  }
  console.log("\n========== NODE-BEARING FIELDS ==========");
  if (nodeHints.size === 0) {
    console.log("  none — stream carries NO node id. → Approach A (client-side inference).");
  } else {
    console.log("  FOUND node-ish fields → Approach B (read exact node from stream) is viable:");
    for (const [type, set] of nodeHints) {
      console.log(`  [${type}]`);
      set.forEach((h) => console.log(`     - ${h}`));
    }
  }
  console.log("=========================================\n");
}
