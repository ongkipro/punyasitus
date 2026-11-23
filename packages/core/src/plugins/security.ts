/**
 * Shared security helpers for Frozen-Core Plugin Runtime (REQ-097, TASK-097):
 * - Constant-time secret string comparison (`constantTimeEqual`)
 * - Bounded request body stream reader (`readBoundedRequestBody`)
 * - Plugin config size/depth/key-count caps (`validatePluginConfigLimits`)
 * - Real emitted public JS byte measurement (`measureEmittedPublicJsBytes`)
 */

export const MAX_PLUGIN_CONFIG_BYTES = 16_384 as const; // 16 KiB
export const MAX_PLUGIN_CONFIG_DEPTH = 6 as const;
export const MAX_PLUGIN_CONFIG_KEYS = 100 as const;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Constant-time UTF-8 string comparison preventing timing leaks on webhook secret checks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = TEXT_ENCODER.encode(a);
  const bBytes = TEXT_ENCODER.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i += 1) {
    const ba = i < aBytes.length ? aBytes[i]! : 0;
    const bb = i < bBytes.length ? bBytes[i]! : 0;
    diff |= ba ^ bb;
  }
  return diff === 0;
}

export type BoundedBodyReadResult =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: "too_large" | "read_error" };

/**
 * Pre-checks `Content-Length` AND streams `request.body` with an immediate hard byte
 * ceiling so oversized or unlabelled chunked payloads can never OOM the Worker.
 */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyReadResult> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader.trim());
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  if (!request.body) {
    return { ok: true, text: "", bytes: 0 };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort cancel
        }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "read_error" };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    ok: true,
    text: TEXT_DECODER.decode(combined),
    bytes: totalBytes,
  };
}

export interface PluginConfigLimitValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Enforces hard platform ceilings on `installed_plugins.config_json`:
 * - Serialized UTF-8 size `<= 16 KiB`
 * - Max nesting depth `<= 6`
 * - Max total object keys across tree `<= 100`
 */
export function validatePluginConfigLimits(
  config: Record<string, unknown>,
  limits?: {
    readonly maxBytes?: number;
    readonly maxDepth?: number;
    readonly maxKeys?: number;
  },
): PluginConfigLimitValidationResult {
  const maxBytes = limits?.maxBytes ?? MAX_PLUGIN_CONFIG_BYTES;
  const maxDepth = limits?.maxDepth ?? MAX_PLUGIN_CONFIG_DEPTH;
  const maxKeys = limits?.maxKeys ?? MAX_PLUGIN_CONFIG_KEYS;

  let serialized: string;
  try {
    serialized = JSON.stringify(config);
  } catch {
    return { ok: false, reason: "Konfigurasi plugin tidak dapat diserialisasi ke JSON." };
  }

  const byteLen = TEXT_ENCODER.encode(serialized).byteLength;
  if (byteLen > maxBytes) {
    return {
      ok: false,
      reason: `Ukuran konfigurasi plugin (${byteLen} byte) melebihi batas maksimal ${maxBytes} byte.`,
    };
  }

  let totalKeys = 0;
  const visit = (node: unknown, depth: number): string | null => {
    if (depth > maxDepth) {
      return `Kedalaman struktur konfigurasi plugin melebihi batas maksimal ${maxDepth} tingkat.`;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const err = visit(item, depth + 1);
        if (err) return err;
      }
      return null;
    }
    if (node !== null && typeof node === "object") {
      const keys = Object.keys(node as Record<string, unknown>);
      totalKeys += keys.length;
      if (totalKeys > maxKeys) {
        return `Jumlah kunci konfigurasi plugin melebihi batas maksimal ${maxKeys}.`;
      }
      for (const k of keys) {
        const err = visit((node as Record<string, unknown>)[k], depth + 1);
        if (err) return err;
      }
    }
    return null;
  };

  const err = visit(config, 1);
  if (err) {
    return { ok: false, reason: err };
  }
  return { ok: true };
}

const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Measures actual emitted public JS UTF-8 byte length across both `inlineJs` and any
 * `<script>...</script>` tags embedded inside plugin HTML, taking the maximum against
 * self-reported `declaredJsBytes` so a plugin can never under-report its JS footprint.
 */
export function measureEmittedPublicJsBytes(input: {
  readonly html: string;
  readonly inlineJs?: string;
  readonly declaredJsBytes?: number;
}): number {
  let emittedBytes = 0;

  if (input.inlineJs) {
    emittedBytes += TEXT_ENCODER.encode(input.inlineJs).byteLength;
  }

  SCRIPT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_BLOCK_RE.exec(input.html)) !== null) {
    const body = match[1] ?? "";
    emittedBytes += TEXT_ENCODER.encode(body).byteLength;
  }

  const declared =
    typeof input.declaredJsBytes === "number" && Number.isFinite(input.declaredJsBytes)
      ? Math.max(0, Math.trunc(input.declaredJsBytes))
      : 0;

  return Math.max(declared, emittedBytes);
}
