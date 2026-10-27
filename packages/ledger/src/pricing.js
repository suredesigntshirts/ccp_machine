// API list prices in US dollars per million tokens, read 2026-10-26 from
// https://platform.claude.com/docs/en/about-claude/pricing.md. Re-check before trusting a total.
export const PRICES = {
  'claude-fable-5-1': { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
  'claude-opus-5-5': { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 },
  // Haiku 5.5 bills a whole request at this row once its prompt passes 100k tokens.
  'claude-haiku-5-5:long': { input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 }
};

export const baseModel = (model = '') => model.replace(/\[.*\]$/, '');

/** Cost of one request's usage block, in dollars. Unknown models cost null, never a guess. */
export function requestCost(model, usage) {
  const m = baseModel(model);
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h =
    usage.cache_creation?.ephemeral_1h_input_tokens ??
    Math.max(0, (usage.cache_creation_input_tokens ?? 0) - write5m);
  const input = usage.input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const prompt = input + read + write5m + write1h;
  const p = PRICES[m === 'claude-haiku-5-5' && prompt > 100_000 ? `${m}:long` : m];
  if (!p) return null;
  return (input * p.input + write5m * p.write5m + write1h * p.write1h + read * p.read + output * p.output) / 1e6;
}
