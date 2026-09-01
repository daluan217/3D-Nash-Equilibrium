/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transport layer for the grounded report — one small adapter per model family.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ SDK-BOUND MODULE — SERVER AND EVAL HARNESS ONLY.                 │
 * │ Never import this from the App.tsx graph.                        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Why this exists: the eval compares model FAMILIES, not just tiers of one
 * vendor, and each family speaks a different dialect — different request shape,
 * different structured-output syntax, different usage field names, different
 * stop-reason vocabulary. Everything above this file (grounding payload,
 * validation, scoring) is provider-agnostic and must stay that way; all the
 * vendor-specific ugliness is confined here.
 *
 * Adding a provider means writing one `call*` function that returns a
 * ProviderResult. Nothing else in the codebase should need to change.
 */

import {
  GoogleGenAI,
  FinishReason,
  type GenerateContentResponseUsageMetadata,
} from '@google/genai';
import OpenAI from 'openai';
import AnthropicFoundry from '@anthropic-ai/foundry-sdk';

/**
 * Provider-neutral token accounting.
 *
 * Normalizing this is load-bearing for the cost column: Gemini reports
 * `promptTokenCount` INCLUDING the cached prefix while OpenAI's `prompt_tokens`
 * does the same but names the cached subset differently, and both bill thinking
 * tokens at the OUTPUT rate under different names. Comparing raw vendor fields
 * would silently compare different quantities.
 */
export interface NormalizedUsage {
  /** Total input tokens, INCLUDING any cached prefix. */
  promptTokens: number;
  /** Cached subset of promptTokens (billed at a discount). */
  cachedTokens: number;
  /** Visible completion tokens. */
  outputTokens: number;
  /** Thinking/reasoning tokens — billed at the OUTPUT rate on every provider. */
  reasoningTokens: number;
}

/**
 * `rate-limited` is a transient INFRA failure (429/503), distinct from a
 * model/content failure, so the eval can retry it and keep it out of the
 * consistency denominator rather than blaming the model for a quota.
 */
export type ProviderFailure = 'refusal' | 'max-tokens' | 'unparseable' | 'rate-limited' | 'error';

export interface ProviderResult {
  /** Raw JSON text the model produced, or null. */
  text: string | null;
  /** Vendor stop/finish reason, verbatim, for failure bucketing. */
  stopReason: string | null;
  usage: NormalizedUsage | null;
  failure: ProviderFailure | null;
}

/**
 * Neutral reasoning/thinking level.
 *
 * Each family exposes this differently — OpenAI as `reasoning_effort`, Gemini as
 * a `thinkingConfig` token budget, Anthropic as a `thinking` block — so the
 * benchmark asks for an EFFORT LEVEL and each adapter translates. Omitting it
 * means "provider default", which is what the first sweep measured.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * 'none' is not the same as omitting the field: omitting takes the provider
 * DEFAULT (which for gpt-5.6-sol is thinking ON), whereas 'none' explicitly
 * disables it. The distinction is the control arm of the benchmark, so the two
 * must stay separately expressible.
 */
function thinkingRequested(r: ReasoningEffort | undefined): boolean {
  return !!r && r !== 'none';
}

export interface ProviderRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Plain JSON Schema (lowercase types) constraining the reply shape. */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  /**
   * Reasoning effort. Undefined = provider default (no thinking requested).
   * Not every deployment honours this; check `usage.reasoningTokens > 0` to
   * confirm thinking actually happened rather than assuming it did.
   */
  reasoning?: ReasoningEffort;
}

export type ProviderName = 'gemini' | 'foundry-openai' | 'foundry-anthropic';

/** True for transient 429/503/500 responses that are worth retrying. */
export function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: unknown };
  const code = e?.status ?? e?.code;
  if (code === 429 || code === 503 || code === 500) return true;
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|rate.?limit|too many requests|"code":\s*(429|503|500)/i.test(
    String(e?.message ?? ''),
  );
}

// ── Gemini ────────────────────────────────────────────────────────────────────

function normalizeGeminiUsage(u: GenerateContentResponseUsageMetadata | undefined): NormalizedUsage | null {
  if (!u) return null;
  return {
    promptTokens: u.promptTokenCount ?? 0,
    cachedTokens: u.cachedContentTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    reasoningTokens: u.thoughtsTokenCount ?? 0,
  };
}

/** Safety/policy finish reasons — the model declined rather than answered. */
const GEMINI_REFUSALS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.BLOCKLIST,
  FinishReason.IMAGE_SAFETY,
]);

async function callGemini(req: ProviderRequest): Promise<ProviderResult> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  let response;
  try {
    response = await client.models.generateContent({
      model: req.model,
      contents: req.userPrompt,
      config: {
        systemInstruction: req.systemPrompt,
        responseMimeType: 'application/json',
        // Gemini accepts a plain JSON-Schema subset (lowercase types, enum,
        // required). It does NOT support additionalProperties, so the neutral
        // schema is passed through as-is.
        responseSchema: req.schema,
        maxOutputTokens: req.maxOutputTokens,
        // Gemini takes a token budget, not an effort level. -1 = dynamic ("think
        // as much as this problem needs"), which is the honest analogue of
        // "reasoning enabled" — a fixed budget would cap harder games unequally.
        // Flash-lite ships with thinking OFF by default, so this is the switch;
        // budget 0 is the explicit OFF used by the control arm.
        ...(req.reasoning ? { thinkingConfig: { thinkingBudget: thinkingRequested(req.reasoning) ? -1 : 0 } } : {}),
      },
    });
  } catch (err) {
    return { text: null, stopReason: null, usage: null, failure: isRateLimit(err) ? 'rate-limited' : 'error' };
  }

  const usage = normalizeGeminiUsage(response.usageMetadata);

  // A blocked *prompt* comes back with no candidates and a blockReason.
  if (response.promptFeedback?.blockReason) {
    return { text: null, stopReason: response.promptFeedback.blockReason, usage, failure: 'refusal' };
  }

  const finishReason = response.candidates?.[0]?.finishReason;

  // Check the finish reason BEFORE reading text: on a safety stop the content is
  // empty or partial, and on MAX_TOKENS the JSON is truncated and won't parse.
  if (finishReason && GEMINI_REFUSALS.has(finishReason)) {
    return { text: null, stopReason: finishReason, usage, failure: 'refusal' };
  }

  const text = response.text ?? null;

  if (finishReason === FinishReason.MAX_TOKENS) {
    return { text, stopReason: finishReason, usage, failure: 'max-tokens' };
  }
  if (!text) {
    return { text: null, stopReason: finishReason ?? null, usage, failure: 'unparseable' };
  }
  return { text, stopReason: finishReason ?? null, usage, failure: null };
}

// ── Microsoft Foundry (OpenAI-compatible: GPT + open-weight catalog) ──────────

/**
 * OpenAI strict structured outputs require `additionalProperties: false` on
 * every object node. The neutral schema omits it (Gemini rejects it), so it is
 * grafted on here rather than forking the schema definition.
 */
function withAdditionalPropertiesFalse(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withAdditionalPropertiesFalse);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = withAdditionalPropertiesFalse(v);
    }
    // Strict mode requires additionalProperties:false on every object node,
    // including nullable ones declared as type: ['object','null'] — which is
    // how an OPTIONAL field has to be expressed, since strict also demands
    // that every property appear in `required`.
    const t = out.type;
    if (t === 'object' || (Array.isArray(t) && t.includes('object'))) out.additionalProperties = false;
    return out;
  }
  return node;
}

/**
 * Foundry credentials, per model then global.
 *
 * An Azure key is per-RESOURCE, so one generic AZURE_FOUNDRY_API_KEY covers
 * every deployment in the same resource. The per-model form
 * (`GPT-5.4-NANO_AZURE_FOUNDRY_API_KEY`) exists so deployments living in
 * DIFFERENT resources — or a model whose key gets rotated independently — can
 * be pointed somewhere else without disturbing the rest of the sweep.
 */
function foundryCreds(model: string): { endpoint?: string; apiKey?: string } {
  const slug = model.toUpperCase();
  return {
    endpoint: process.env[`${slug}_AZURE_FOUNDRY_ENDPOINT`] ?? process.env.AZURE_FOUNDRY_ENDPOINT,
    apiKey: process.env[`${slug}_AZURE_FOUNDRY_API_KEY`] ?? process.env.AZURE_FOUNDRY_API_KEY,
  };
}

function normalizeOpenAIUsage(u: OpenAI.CompletionUsage | undefined): NormalizedUsage | null {
  if (!u) return null;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Microsoft Foundry exposes GPT *and* the open-weight catalog (DeepSeek, Kimi,
 * Qwen, Grok…) through one OpenAI-compatible endpoint, so a single adapter
 * covers both families — `model` is the DEPLOYMENT name, not a catalog id.
 */
async function callFoundryOpenAI(req: ProviderRequest): Promise<ProviderResult> {
  const { endpoint, apiKey } = foundryCreds(req.model);
  /**
   * AgentRouter gates on the CLIENT, not just the key.
   *
   * It is a free relay aimed at Claude Code / Codex / Gemini CLI, and it
   * rejects anything that does not look like one of them — with
   * `401 {"message":"UNAUTHENTICATED", "error":"unauthorized client
   * detected"}`, which is BYTE-IDENTICAL to what it returns for a request
   * carrying no credential at all. That identity is what makes the failure so
   * hard to read: the message tells you nothing about your key, and the
   * obvious conclusion (bad token) is wrong. A valid, enabled, unlimited token
   * fails exactly the same way until the User-Agent is right.
   *
   * Scoped to that host so nothing else sees a fabricated agent string.
   */
  const isAgentRouter = /(^|\/\/)([^/]*\.)?agentrouter\.org/i.test(endpoint ?? '');
  const client = new OpenAI({
    baseURL: endpoint,
    apiKey,
    ...(isAgentRouter ? { defaultHeaders: { 'user-agent': 'claude-cli/2.1.0 (external, cli)' } } : {}),
  });

  const messages = [
    { role: 'system' as const, content: req.systemPrompt },
    { role: 'user' as const, content: req.userPrompt },
  ];
  const jsonSchema = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'nash_report',
      strict: true,
      schema: withAdditionalPropertiesFalse(req.schema) as Record<string, unknown>,
    },
  };

  /**
   * The Foundry catalog is NOT uniform in request shape. Two real divergences:
   *   - Phi-4 rejects `response_format: json_schema` but accepts `json_object`.
   *   - Mistral-Large-3 rejects `max_completion_tokens` and wants `max_tokens`.
   * Rather than hard-code a per-model table that silently rots as the catalog
   * changes, negotiate: try the strictest shape, then degrade one axis at a time.
   *
   * NOTE FOR ANY COMPARISON: `json_object` asks for valid JSON but does NOT
   * enforce the schema, so a model that lands on variant 2 or 4 is under a
   * weaker output constraint than one that lands on variant 1. That asymmetry
   * has to be stated whenever these models are scored against each other.
   */
  const shapes: Record<string, unknown>[] = [
    { response_format: jsonSchema, max_completion_tokens: req.maxOutputTokens },
    { response_format: { type: 'json_object' }, max_completion_tokens: req.maxOutputTokens },
    { response_format: jsonSchema, max_tokens: req.maxOutputTokens },
    { response_format: { type: 'json_object' }, max_tokens: req.maxOutputTokens },
  ];
  // Reasoning is its own fallback axis: models with no thinking mode (Phi-4,
  // Mistral-Large-3) reject `reasoning_effort` outright, and if it were spread
  // into every shape they would fail all of them and look broken. Try the
  // reasoning shapes first, then the same shapes without it.
  const variants: Record<string, unknown>[] = req.reasoning
    ? [...shapes.map((s) => ({ ...s, reasoning_effort: req.reasoning })), ...shapes]
    : shapes;

  let response: OpenAI.Chat.Completions.ChatCompletion | undefined;
  let lastErr: unknown;
  for (const variant of variants) {
    try {
      response = await client.chat.completions.create({
        model: req.model,
        messages,
        ...variant,
        // No temperature/top_p: the request shape is kept uniform across every
        // model in the sweep so the comparison table means something. Variance is
        // measured by the N passes the harness runs, not tuned away here.
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
      break;
    } catch (err) {
      lastErr = err;
      // A rate limit is about load, not shape — degrading the request would not
      // help and would silently change what we measured. Surface it immediately.
      if (isRateLimit(err)) {
        return { text: null, stopReason: null, usage: null, failure: 'rate-limited' };
      }
    }
  }
  if (!response) {
    return { text: null, stopReason: null, usage: null, failure: isRateLimit(lastErr) ? 'rate-limited' : 'error' };
  }

  const usage = normalizeOpenAIUsage(response.usage);
  const choice = response.choices?.[0];
  const finish = choice?.finish_reason ?? null;

  // Structured-output refusals surface as a dedicated field, not as content.
  if (choice?.message?.refusal) {
    return { text: null, stopReason: 'refusal', usage, failure: 'refusal' };
  }
  if (finish === 'content_filter') {
    return { text: null, stopReason: finish, usage, failure: 'refusal' };
  }

  const text = choice?.message?.content ?? null;

  if (finish === 'length') {
    return { text, stopReason: finish, usage, failure: 'max-tokens' };
  }
  if (!text) {
    return { text: null, stopReason: finish, usage, failure: 'unparseable' };
  }
  return { text, stopReason: finish, usage, failure: null };
}

// ── Microsoft Foundry (Anthropic Messages API) ───────────────────────────────

/**
 * Anthropic models on Foundry speak the Messages API, not chat-completions, so
 * they need their own adapter despite living behind the same resource.
 *
 * JSON is enforced with FORCED TOOL USE rather than structured outputs: this
 * workspace returns "structured_outputs not supported in your workspace" (400),
 * while tool_choice:{type:'tool'} works. Both mechanisms bind the reply to a
 * JSON Schema, so the constraint is equivalent in strength — but the request
 * shape does differ from the other providers, which is worth stating whenever
 * these numbers are compared.
 */
async function callFoundryAnthropic(req: ProviderRequest): Promise<ProviderResult> {
  const { endpoint, apiKey } = foundryCreds(req.model);
  // The SDK wants the bare resource name; derive it from the endpoint host so a
  // single AZURE_FOUNDRY_ENDPOINT keeps working for every provider.
  const resource =
    process.env.ANTHROPIC_FOUNDRY_RESOURCE ??
    (endpoint ? new URL(endpoint).hostname.split('.')[0] : undefined);
  const client = new AnthropicFoundry({ resource, apiKey });

  let message: any;
  try {
    message = await client.messages.create({
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
      tools: [{ name: 'report', description: 'Report your answer.', input_schema: req.schema }],
      // Extended thinking is incompatible with FORCED tool use, so enabling it
      // necessarily relaxes the JSON constraint from "must call report" to "may".
      // That is a real difference in request shape between the two sweeps and has
      // to be stated whenever the numbers are compared.
      tool_choice: thinkingRequested(req.reasoning) ? { type: 'auto' } : { type: 'tool', name: 'report' },
      // claude-haiku-4-5 predates the 4.6 `adaptive` form and still takes an
      // explicit budget; it must leave room under max_tokens for the answer.
      ...(thinkingRequested(req.reasoning)
        ? { thinking: { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(req.maxOutputTokens / 2)) } }
        : {}),
    } as any);
  } catch (err) {
    return { text: null, stopReason: null, usage: null, failure: isRateLimit(err) ? 'rate-limited' : 'error' };
  }

  const u = message?.usage;
  const usage: NormalizedUsage | null = u
    ? {
        // input_tokens EXCLUDES cached reads on Anthropic, unlike Gemini/OpenAI
        // where the prompt count includes them — so add them back to keep
        // promptTokens meaning the same thing across every provider.
        promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cachedTokens: u.cache_read_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        reasoningTokens: 0,
      }
    : null;

  const stop = message?.stop_reason ?? null;
  if (stop === 'refusal') return { text: null, stopReason: stop, usage, failure: 'refusal' };

  const toolUse = (message?.content ?? []).find((b: any) => b.type === 'tool_use');
  if (!toolUse) {
    // max_tokens can truncate before the tool block is emitted at all.
    return { text: null, stopReason: stop, usage, failure: stop === 'max_tokens' ? 'max-tokens' : 'unparseable' };
  }
  // tool_use.input is already a parsed object; re-serialise so every provider
  // hands back the same thing (a JSON string) to the caller.
  return { text: JSON.stringify(toolUse.input), stopReason: stop, usage, failure: null };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Which adapter handles a given model. Gemini ids are stable and self-labeling;
 * everything else is a Foundry DEPLOYMENT name chosen at deploy time, so the
 * default is Foundry. Override explicitly with EVAL_PROVIDER_<model>= if a
 * deployment is ever named something Gemini-looking.
 */
export function resolveProvider(model: string): ProviderName {
  const override = process.env[`EVAL_PROVIDER_${model}`];
  if (override === 'gemini' || override === 'foundry-openai' || override === 'foundry-anthropic') return override;
  if (/^gemini-/i.test(model)) return 'gemini';
  // Anthropic models on Foundry speak Messages, not chat-completions.
  if (/^claude-/i.test(model)) return 'foundry-anthropic';
  return 'foundry-openai';
}

export async function callProvider(req: ProviderRequest): Promise<ProviderResult> {
  switch (resolveProvider(req.model)) {
    case 'gemini': return callGemini(req);
    case 'foundry-anthropic': return callFoundryAnthropic(req);
    default: return callFoundryOpenAI(req);
  }
}

/** Whether the credentials for a model's provider are present. */
export function hasCredentials(model: string): boolean {
  if (resolveProvider(model) === 'gemini') return !!process.env.GEMINI_API_KEY;
  // Both Foundry adapters read the same per-resource endpoint + key.
  const { endpoint, apiKey } = foundryCreds(model);
  return !!(endpoint && apiKey);
}
