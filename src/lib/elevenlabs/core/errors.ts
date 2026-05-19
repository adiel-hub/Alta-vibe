export class ElevenLabsError extends Error {
  status: number;
  section: string;
  body: unknown;
  constructor(status: number, section: string, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.section = section;
    this.body = body;
  }
}

export function extractErrorMessage(body: unknown): string | null {
  if (typeof body === "string" && body.length > 0) return body;
  if (typeof body !== "object" || body === null) return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  // FastAPI/Pydantic validation errors: detail is an array of
  //   { loc: ["body", "tool_config", "api_schema", ...], msg, type }.
  // Flatten to "field.path: msg; field.path: msg" so callers see exactly
  // which part of the request ElevenLabs rejected — critical for debugging
  // 422s out of /v1/convai/tools where the failure is almost always a
  // schema/shape problem on a specific field.
  if (Array.isArray(detail)) {
    const items = (detail as unknown[])
      .map((it) => {
        if (typeof it !== "object" || it === null) return null;
        const msg = (it as { msg?: unknown }).msg;
        if (typeof msg !== "string") return null;
        const loc = (it as { loc?: unknown }).loc;
        const path = Array.isArray(loc)
          ? loc
              .filter((p) => p !== "body" && (typeof p === "string" || typeof p === "number"))
              .join(".")
          : "";
        return path ? `${path}: ${msg}` : msg;
      })
      .filter((s): s is string => s !== null);
    if (items.length > 0) return items.join("; ");
  }
  if (typeof detail === "object" && detail !== null) {
    const msg = (detail as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  const topMsg = (body as { message?: unknown }).message;
  if (typeof topMsg === "string") return topMsg;
  return null;
}
