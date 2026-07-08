// B-llm structured output, step one of the double gate (Guide B6): provider
// "JSON modes" fail rarely but confidently, so LLM JSON is re-parsed here and
// ALWAYS re-checked with our own safeParse (via validateAt) by the caller.
// Lives in src/llm/ — the B-llm boundary home — so JSON.parse of model output
// has exactly one audited site.

/**
 * Best-effort JSON extraction from an LLM completion: the raw text, or the
 * text inside the first ```json fence (models add fences despite
 * instructions). Returns `unknown` for validateAt, or null when nothing
 * parses — the caller rejects, never repairs (Guide B4).
 */
export function parseLlmJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // CATCH-OK: unparseable model output is a rejection value, not an error.
    return null;
  }
}
