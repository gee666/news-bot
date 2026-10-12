import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Tokenizer } from '@huggingface/tokenizers';
import { z } from 'zod';
import { RequestFault } from './errors.js';
import type { Json } from './jev-state.js';
import type { JevQuestion } from './templates.js';
import { jevContextBudgetSchema, type JevContextBudget } from './jev-budget.js';

const artifactHash = 'a77a45a635f94562a03458f9e4d50f2e2d77fe5c30b86d1bd09f386e8fb8d7a3';
const artifactSchema = z.object({ model: z.literal('autojev-27b-q4_k_m'), pre: z.literal('qwen35'),
  tokenizer: z.object({ model: z.object({ type: z.literal('BPE'), vocab: z.record(z.string(), z.number().int().nonnegative()),
    merges: z.array(z.string()) }).passthrough() }).passthrough(), config: z.object({}).passthrough(),
  codes: z.array(z.string().min(1)).length(255) });
let loaded: Promise<{ tokenizer: Tokenizer; codes: string[] }> | undefined;
async function tokenizer() {
  loaded ??= (async () => {
    const raw = gunzipSync(await readFile(new URL('../../model-data/autojev-qwen35-tokenizer.json.gz', import.meta.url)));
    if (createHash('sha256').update(raw).digest('hex') !== artifactHash) throw new Error('JEV tokenizer artifact integrity failed');
    const value: unknown = JSON.parse(raw.toString('utf8'));
    const data = artifactSchema.parse(value);
    return { tokenizer: new Tokenizer(data.tokenizer, data.config), codes: data.codes };
  })().catch(error => { loaded = undefined; throw error; });
  return loaded;
}

/** Mirror AutoJev's describe/python_json_dump formatting; count the entire rendered question, not just state. */
export function describeJev(value: Json): string {
  if (typeof value === 'string') return value;
  return dump(value);
}
function dump(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(dump).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ': ' + dump(value[key] ?? null)).join(', ') + '}';
  return JSON.stringify(value);
}
export function renderJevPrompt(state: Json, question: JevQuestion, codes: readonly string[], prefixCache: boolean): string {
  const options = question.type === 'score' ? question.criteria.map(String)
    : question.type === 'choice' ? Object.keys(question.criteria).sort().map(key => `${key}: ${question.criteria[key]}`)
      : [question.criteria.false || 'No / false', question.criteria.true || 'Yes / true'];
  const described = options.map((description, index) => `${codes[index]}: ${description}`).join('\n');
  const questionPrefix = `Question:\n${question.instructions}\n\nOptions:\n${described}\n\n`;
  return prefixCache ? questionPrefix + 'State:\n' + describeJev(state) + '\n\nReturn only the letter code of the best option.'
    : 'State:\n' + describeJev(state) + '\n\n' + questionPrefix.trimEnd() + '\n\nReturn only the letter code of the best option.';
}

export async function measureJevContext(state: Json, questions: Record<string, JevQuestion>, capacity: number,
  model: string, prefixCache: boolean, reservedTokens = 512): Promise<JevContextBudget> {
  const supported = model === 'autojev-27b-q4_k_m';
  const data = supported ? await tokenizer() : undefined;
  let promptTokens = 0;
  let inputBytes = 0;
  for (const question of Object.values(questions)) {
    const prompt = renderJevPrompt(state, question, data?.codes ?? Array.from({ length: 255 }, (_, index) => `option_${index}`), prefixCache);
    const bytes = Buffer.byteLength(prompt);
    inputBytes = Math.max(inputBytes, bytes);
    promptTokens = Math.max(promptTokens, data ? data.tokenizer.encode(prompt, { add_special_tokens: false }).ids.length : bytes);
  }
  return jevContextBudgetSchema.parse({ method: supported ? 'autojev_qwen35' : 'utf8_upper_bound', promptTokens,
    reservedTokens, contextTokens: capacity, inputBytes });
}
export function requireJevContext(budget: JevContextBudget): void {
  if (budget.promptTokens + budget.reservedTokens >= budget.contextTokens) {
    throw new RequestFault('context_limit', { outcome: 'not_submitted', jevContextBudget: budget });
  }
}
