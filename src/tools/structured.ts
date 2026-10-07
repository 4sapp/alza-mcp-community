/**
 * `structuredContent` must be a JSON object, and the SDK validates it against
 * the tool's outputSchema (an object). Alza answers some calls with a 2xx and
 * an empty body (204/202), JSON `null`, an array, or text. Passing those
 * through raw made the SDK report an output-validation error AFTER the request
 * was sent and the one-time token spent (issue #63), inviting a duplicate
 * retry. Non-object bodies are wrapped in an explicit "accepted" object instead.
 */
export function toStructuredContent(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const empty = value === null || value === undefined || value === "";
  return {
    accepted: true,
    data: value ?? null,
    note: empty
      ? "Alza answered with a 2xx status and an empty body: the request was sent and accepted. For a mutation, do not repeat it (its confirmation token is spent); re-read the affected resource to confirm the result."
      : "Alza answered with a 2xx status and a body that is not a JSON object (array or text); it is returned unchanged in `data`.",
  };
}
