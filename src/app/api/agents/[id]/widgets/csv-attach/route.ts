/**
 * User-initiated CSV upload from the chat input. Unlike the csv_upload widget
 * created by `present_csv_upload_widget` (which the agent calls during a
 * turn), this endpoint lets the user open the same widget directly by
 * attaching a CSV from the chat composer.
 *
 * Creates a `widget_actions` row with kind=csv_upload and the file content
 * pre-loaded into `payload.prefill_text` so the widget can skip straight to
 * the mapping step. No turn job is enqueued at attach-time — the agent only
 * resumes after the widget is resolved (the existing resolve route handles
 * that path).
 *
 * Widgets created this way have no `turn_job_id` and no `tool_use_id`; the
 * chat panel renders them as orphan widgets at the bottom of the scroller.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, widgetActionsCol } from "@/lib/mongodb";
import { parseCsv } from "@/lib/csv/parse";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap the file size to keep widget payloads small and avoid prompt blowups
// when the agent later sees the import summary. Real audiences with many
// rows still fit; 2 MB is ~20k typical CSV rows.
const MAX_CSV_BYTES = 2 * 1024 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("widget", {
    route: "POST /widgets/csv-attach",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const agentId = new ObjectId(id);

  const agent = await (await agentsCol()).findOne({ _id: agentId });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const filename =
    file instanceof File && file.name ? file.name : "attachment.csv";
  if (!/\.csv$/i.test(filename) && file.type && !/csv/i.test(file.type)) {
    return NextResponse.json(
      { error: "Only CSV files are supported." },
      { status: 415 },
    );
  }
  if (file.size > MAX_CSV_BYTES) {
    return NextResponse.json(
      { error: `File is too large (max ${MAX_CSV_BYTES / 1024 / 1024} MB).` },
      { status: 413 },
    );
  }

  const text = await file.text();
  if (!text.trim()) {
    return NextResponse.json({ error: "CSV is empty." }, { status: 400 });
  }

  // Sanity-parse so we can surface a useful row/column count and reject
  // garbage early. The widget re-parses client-side, so we don't persist
  // anything beyond the raw text.
  let preview: { rows: number; columns: number };
  try {
    const { headers, rows } = parseCsv(text);
    if (headers.length === 0) {
      return NextResponse.json(
        { error: "CSV has no header row." },
        { status: 400 },
      );
    }
    preview = { rows: rows.length, columns: headers.length };
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "CSV parse failed" },
      { status: 400 },
    );
  }

  const widgets = await widgetActionsCol();
  const payload = {
    title: filename,
    prefill_text: text,
    rows: preview.rows,
    columns: preview.columns,
  };
  const insert = await widgets.insertOne({
    agent_id: agentId,
    turn_job_id: null,
    kind: "csv_upload",
    payload,
    status: "pending",
    result: null,
    created_at: new Date(),
    resolved_at: null,
  } as never);

  log.info("csv attached", {
    agent_id: id,
    action_id: insert.insertedId.toHexString(),
    filename,
    rows: preview.rows,
    columns: preview.columns,
    bytes: file.size,
  });

  return NextResponse.json({
    widget: {
      action_id: insert.insertedId.toHexString(),
      kind: "csv_upload",
      payload,
      status: "pending",
      result: null,
    },
  });
}
