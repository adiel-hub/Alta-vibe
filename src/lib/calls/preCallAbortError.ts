/**
 * Thrown when a pre-call tool with `abort_on_failure: true` fails — either
 * by error, timeout, non-2xx upstream response, or returning a null/false
 * sentinel that the tool author chose to treat as "do not place this call."
 *
 * The outbound-call route catches this and returns 412; the campaign runner
 * catches it and marks the item `skipped` with a structured reason.
 */
export class PreCallAbortError extends Error {
  readonly tool_name: string;
  readonly reason: string;

  constructor(toolName: string, reason: string) {
    super(`Pre-call aborted by "${toolName}": ${reason}`);
    this.name = "PreCallAbortError";
    this.tool_name = toolName;
    this.reason = reason;
  }
}

export function isPreCallAbortError(err: unknown): err is PreCallAbortError {
  return err instanceof PreCallAbortError;
}
