// Tolerant JSON-object extraction for structured LLM output. The model often
// wraps the object in prose or code fences, so we try a strict parse first and
// then fall back to the first `{...}` span.

/** Parse `text` as a JSON object, returning null for non-objects or arrays. */
export function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Extract the first JSON object from `text`. Tries a strict parse of the whole
 * (trimmed) string, then the first `{...}` span. Returns null if neither yields
 * a plain object.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct) {
    return direct;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  return tryParseJson(match[0]);
}
