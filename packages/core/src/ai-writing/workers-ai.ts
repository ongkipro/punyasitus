import { sanitizeAiOutputText } from "./schema.ts";
import {
  AiWritingProviderError,
  DEFAULT_WORKERS_AI_GATEWAY_ID,
  DEFAULT_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_TIMEOUT_MS,
  type AiWritingProviderPort,
  type AiWritingProviderRequest,
  type AiWritingProviderResult,
} from "./types.ts";

/**
 * Cloudflare Workers AI adapter implementing `AiWritingProviderPort` (`AiWritingPort`)
 * routed through Cloudflare AI Gateway (`punyasitus-*`) per DEC-046 & PLAN §18.4.
 */

export interface WorkersAiChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface WorkersAiRunInput {
  readonly messages: readonly WorkersAiChatMessage[];
  readonly max_tokens: number;
  readonly temperature: number;
}

export interface WorkersAiRunOptions {
  readonly gateway?: {
    readonly id: string;
    readonly skipCache?: boolean;
  };
}

export interface WorkersAiBindingLike {
  run(
    model: string,
    inputs: WorkersAiRunInput,
    options?: WorkersAiRunOptions,
  ): Promise<unknown>;
}

export interface CreateCloudflareWorkersAiPortOptions {
  readonly ai: WorkersAiBindingLike;
  readonly model?: string;
  readonly gatewayId?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export function extractWorkersAiTextAndTokens(raw: unknown): {
  readonly text: string | null;
  readonly tokenCount: number | null;
} {
  if (!raw || typeof raw !== "object") {
    return { text: null, tokenCount: null };
  }

  const record = raw as Record<string, unknown>;
  let tokenCount: number | null = null;
  const usage = record.usage;
  if (usage && typeof usage === "object") {
    const usageRec = usage as Record<string, unknown>;
    const total = usageRec.total_tokens;
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
      tokenCount = Math.round(total);
    } else {
      const promptT = typeof usageRec.prompt_tokens === "number" ? usageRec.prompt_tokens : 0;
      const compT = typeof usageRec.completion_tokens === "number" ? usageRec.completion_tokens : 0;
      if (promptT + compT > 0) {
        tokenCount = Math.round(promptT + compT);
      }
    }
  }

  // Standard Workers AI shape: { response: "..." }
  if (typeof record.response === "string" && record.response.trim().length > 0) {
    return { text: record.response, tokenCount };
  }

  // OpenAI-compatible Workers AI shape: { choices: [{ message: { content: "..." } }] }
  if (Array.isArray(record.choices) && record.choices.length > 0) {
    const first = record.choices[0];
    if (first && typeof first === "object") {
      const msg = (first as Record<string, unknown>).message;
      if (msg && typeof msg === "object") {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === "string" && content.trim().length > 0) {
          return { text: content, tokenCount };
        }
      }
    }
  }

  return { text: null, tokenCount };
}

export function createCloudflareWorkersAiPort(
  options: CreateCloudflareWorkersAiPortOptions,
): AiWritingProviderPort {
  const model = options.model?.trim() || DEFAULT_WORKERS_AI_MODEL;
  const defaultGatewayId = options.gatewayId?.trim() || DEFAULT_WORKERS_AI_GATEWAY_ID;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKERS_AI_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return {
    async generateSuggestion(
      request: AiWritingProviderRequest,
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<AiWritingProviderResult> {
      const startedAt = now();
      const gatewayId = request.gatewayId || defaultGatewayId;

      const runPromise = options.ai.run(
        model,
        {
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPrompt },
          ],
          max_tokens: request.maxTokens,
          temperature: 0.4,
        },
        {
          gateway: {
            id: gatewayId,
            // Do not cache editorial suggestions across requests by default
            skipCache: true,
          },
        },
      );

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new AiWritingProviderError(
              "AI_PROVIDER_TIMEOUT",
              "Permintaan ke layanan AI melebihi batas waktu. Teks Anda tetap aman dan kuota tidak terpotong.",
              504,
            ),
          );
        }, timeoutMs);

        if (callOptions?.signal) {
          if (callOptions.signal.aborted) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            reject(
              new AiWritingProviderError(
                "AI_PROVIDER_TIMEOUT",
                "Permintaan ke layanan AI dibatalkan. Kuota tidak terpotong.",
                504,
              ),
            );
            return;
          }
          callOptions.signal.addEventListener(
            "abort",
            () => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              reject(
                new AiWritingProviderError(
                  "AI_PROVIDER_TIMEOUT",
                  "Permintaan ke layanan AI dibatalkan. Kuota tidak terpotong.",
                  504,
                ),
              );
            },
            { once: true },
          );
        }
      });

      let rawResult: unknown;
      try {
        // lazy: Cloudflare Workers AI `env.AI.run` binding does not yet accept an AbortSignal;
        // `Promise.race` enforces the request timeout and atomically refunds tenant quota (0 consumed)
        // while the upstream inference call may settle asynchronously. Upgrade path: pass `{ signal }`
        // into `options.ai.run` once Cloudflare's Workers AI binding adds native AbortSignal support.
        rawResult = await Promise.race([runPromise, timeoutPromise]);
      } catch (err) {
        if (err instanceof AiWritingProviderError) {
          throw err;
        }
        // Never leak raw upstream error bodies (which could echo prompts or internal headers)
        throw new AiWritingProviderError(
          "AI_PROVIDER_ERROR",
          "Layanan bantuan tulis AI sedang mengalami gangguan. Teks Anda tetap aman dan kuota tidak terpotong.",
          502,
        );
      } finally {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
      }

      const latencyMs = Math.max(0, Math.round(now() - startedAt));
      const extracted = extractWorkersAiTextAndTokens(rawResult);
      if (!extracted.text) {
        throw new AiWritingProviderError(
          "AI_PROVIDER_ERROR",
          "Layanan AI tidak mengembalikan draf yang valid. Teks Anda tetap aman dan kuota tidak terpotong.",
          502,
        );
      }

      const sanitized = sanitizeAiOutputText(extracted.text, request.fieldKind);
      if (!sanitized) {
        throw new AiWritingProviderError(
          "AI_PROVIDER_ERROR",
          "Hasil draf AI kosong setelah validasi teks polos. Kuota tidak terpotong.",
          502,
        );
      }

      return {
        suggestion: sanitized,
        model,
        tokenCount: extracted.tokenCount,
        latencyMs,
      };
    },
  };
}
