// Helpers that turn a successful-but-empty chat-completion into a sentence a
// person can read in the Compare Models cards. Self-contained: no imports, so
// it resolves cleanly at build time.

/**
 * One-sentence explanation for a call that returned HTTP 200 with no text.
 * @param {{ finishReason?: string, usage?: object, thinking?: string }} info
 * @returns {string}
 */
export function describeEmptyResponse({ finishReason, usage, thinking } = {}) {
  const completion = Number(usage?.completion_tokens ?? usage?.output_tokens);
  if (finishReason === "length") return "The model spent its whole output budget before writing any text.";
  if (finishReason && /filter|block/i.test(finishReason)) return "The provider filtered the answer before it reached you.";
  if (thinking) return "The model only returned its internal reasoning, with no final answer.";
  if (completion === 0) return "The model reported success but generated zero output tokens.";
  return "The model returned an empty answer, which usually means it refused or the provider sent back nothing.";
}
