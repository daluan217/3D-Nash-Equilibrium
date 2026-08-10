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

export interface ProviderRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Plain JSON Schema (lowercase types) constraining the reply shape. */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}

export type ProviderName = 'gemini' | 'foundry-openai';

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
    if (out.type === 'object') out.additionalProperties = false;
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
  const client = new OpenAI({ baseURL: endpoint, apiKey });

  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: req.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'nash_report',
          strict: true,
          schema: withAdditionalPropertiesFalse(req.schema) as Record<string, unknown>,
        },
      },
      // `max_completion_tokens`, not `max_tokens`: the GPT-5 family rejects the
      // legacy field, and this budget must also cover reasoning tokens.
      max_completion_tokens: req.maxOutputTokens,
      // No temperature/top_p: the request shape is kept uniform across every
      // model in the sweep so the comparison table means something. Variance is
      // measured by the N passes the harness runs, not tuned away here.
    });
  } catch (err) {
    return { text: null, stopReason: null, usage: null, failure: isRateLimit(err) ? 'rate-limited' : 'error' };
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

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Which adapter handles a given model. Gemini ids are stable and self-labeling;
 * everything else is a Foundry DEPLOYMENT name chosen at deploy time, so the
 * default is Foundry. Override explicitly with EVAL_PROVIDER_<model>= if a
 * deployment is ever named something Gemini-looking.
 */
export function resolveProvider(model: string): ProviderName {
  const override = process.env[`EVAL_PROVIDER_${model}`];
  if (override === 'gemini' || override === 'foundry-openai') return override;
  return /^gemini-/i.test(model) ? 'gemini' : 'foundry-openai';
}

export async function callProvider(req: ProviderRequest): Promise<ProviderResult> {
  return resolveProvider(req.model) === 'gemini' ? callGemini(req) : callFoundryOpenAI(req);
}

/** Whether the credentials for a model's provider are present. */
export function hasCredentials(model: string): boolean {
  if (resolveProvider(model) === 'gemini') return !!process.env.GEMINI_API_KEY;
  const { endpoint, apiKey } = foundryCreds(model);
  return !!(endpoint && apiKey);
}
