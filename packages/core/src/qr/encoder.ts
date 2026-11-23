/**
 * Pure-TypeScript deterministic ISO/IEC 18004 QR Code (Versions 1–12, EC Level M, Byte mode)
 * matrix & SVG generator for canonical tenant URLs (`REQ-108`, `PLAN §20.5`).
 *
 * Security & runtime invariants:
 * - Zero external QR API services or outbound network calls.
 * - Zero third-party npm dependencies (runs identically in Node, Cloudflare `workerd`, and browsers).
 * - Deterministic ISO/IEC 18004 output for any UTF-8 payload up to 288 bytes.
 */

interface QrVersionSpec {
  readonly version: number;
  readonly size: number;
  readonly totalCodewords: number;
  readonly dataCodewords: number;
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1Data: number;
  readonly group2Blocks: number;
  readonly group2Data: number;
  readonly alignmentCenters: readonly number[];
}

// ISO/IEC 18004 Table 9 & Annex E (Error Correction Level M, Versions 1..12)
const QR_SPECS_M: readonly QrVersionSpec[] = [
  { version: 1, size: 21, totalCodewords: 26, dataCodewords: 16, ecPerBlock: 10, group1Blocks: 1, group1Data: 16, group2Blocks: 0, group2Data: 0, alignmentCenters: [] },
  { version: 2, size: 25, totalCodewords: 44, dataCodewords: 28, ecPerBlock: 16, group1Blocks: 1, group1Data: 28, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 18] },
  { version: 3, size: 29, totalCodewords: 70, dataCodewords: 44, ecPerBlock: 26, group1Blocks: 1, group1Data: 44, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 22] },
  { version: 4, size: 33, totalCodewords: 100, dataCodewords: 64, ecPerBlock: 18, group1Blocks: 2, group1Data: 32, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 26] },
  { version: 5, size: 37, totalCodewords: 134, dataCodewords: 86, ecPerBlock: 24, group1Blocks: 2, group1Data: 43, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 30] },
  { version: 6, size: 41, totalCodewords: 172, dataCodewords: 108, ecPerBlock: 16, group1Blocks: 4, group1Data: 27, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 34] },
  { version: 7, size: 45, totalCodewords: 196, dataCodewords: 124, ecPerBlock: 18, group1Blocks: 4, group1Data: 31, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 22, 38] },
  { version: 8, size: 49, totalCodewords: 242, dataCodewords: 154, ecPerBlock: 22, group1Blocks: 2, group1Data: 38, group2Blocks: 2, group2Data: 39, alignmentCenters: [6, 24, 42] },
  { version: 9, size: 53, totalCodewords: 292, dataCodewords: 182, ecPerBlock: 22, group1Blocks: 3, group1Data: 36, group2Blocks: 2, group2Data: 37, alignmentCenters: [6, 26, 46] },
  { version: 10, size: 57, totalCodewords: 346, dataCodewords: 216, ecPerBlock: 26, group1Blocks: 4, group1Data: 43, group2Blocks: 1, group2Data: 44, alignmentCenters: [6, 28, 50] },
  { version: 11, size: 61, totalCodewords: 404, dataCodewords: 254, ecPerBlock: 30, group1Blocks: 1, group1Data: 50, group2Blocks: 4, group2Data: 51, alignmentCenters: [6, 30, 54] },
  { version: 12, size: 65, totalCodewords: 466, dataCodewords: 290, ecPerBlock: 22, group1Blocks: 6, group1Data: 36, group2Blocks: 2, group2Data: 37, alignmentCenters: [6, 32, 58] },
];

export const MAX_QR_PAYLOAD_BYTES = 287 as const;
export const DEFAULT_QR_QUIET_ZONE = 4 as const;
export const DEFAULT_QR_FOREGROUND = "#182522" as const;
export const DEFAULT_QR_BACKGROUND = "#ffffff" as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// GF(256) tables with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255] ?? 1;
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i] ?? 1;
    for (let j = 0; j < poly.length; j += 1) {
      const coef = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ coef;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(coef, factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i += 1) {
    const factor = (data[i] ?? 0) ^ (rem[0] ?? 0);
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j += 1) {
        rem[j] = (rem[j] ?? 0) ^ gfMul(gen[j + 1] ?? 0, factor);
      }
    }
  }
  return rem;
}

function selectQrSpec(byteLength: number): QrVersionSpec {
  for (const spec of QR_SPECS_M) {
    const countBits = spec.version <= 9 ? 8 : 16;
    const capacityBits = spec.dataCodewords * 8;
    const requiredBits = 4 + countBits + byteLength * 8;
    if (requiredBits <= capacityBits) {
      return spec;
    }
  }
  throw new Error(`QR payload exceeds supported Version 12-M capacity (${byteLength} bytes).`);
}

function encodeDataCodewords(bytes: Uint8Array, spec: QrVersionSpec): Uint8Array {
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  };

  // Byte mode indicator (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (let i = 0; i < bytes.length; i += 1) {
    pushBits(bytes[i] ?? 0, 8);
  }

  const maxBits = spec.dataCodewords * 8;
  const terminatorLen = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < terminatorLen; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(spec.dataCodewords);
  const filledBytes = bits.length / 8;
  for (let i = 0; i < filledBytes; i += 1) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) {
      b = (b << 1) | (bits[i * 8 + j] ?? 0);
    }
    codewords[i] = b;
  }

  const pads = [0xec, 0x11];
  for (let i = filledBytes, p = 0; i < spec.dataCodewords; i += 1, p += 1) {
    codewords[i] = pads[p % 2] ?? 0xec;
  }
  return codewords;
}

function interleaveCodewords(data: Uint8Array, spec: QrVersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;

  for (let i = 0; i < spec.group1Blocks; i += 1) {
    const block = data.slice(offset, offset + spec.group1Data);
    offset += spec.group1Data;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    const block = data.slice(offset, offset + spec.group2Data);
    offset += spec.group2Data;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
  }

  const out = new Uint8Array(spec.totalCodewords);
  let outIdx = 0;
  const maxDataLen = Math.max(spec.group1Data, spec.group2Data);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        out[outIdx] = block[i] ?? 0;
        outIdx += 1;
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      out[outIdx] = block[i] ?? 0;
      outIdx += 1;
    }
  }
  return out;
}

function computeFormatBits(mask: number): number {
  // EC level M = 00
  const data = (0b00 << 3) | (mask & 0b111);
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >>> i) & 1) {
      rem ^= 0x1f25 << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function applyMaskPredicate(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function scorePenalty(modules: Uint8Array, size: number): number {
  let penalty = 0;
  const at = (r: number, c: number): number => modules[r * size + c] ?? 0;

  // Rule 1: adjacent modules in row/column
  for (let r = 0; r < size; r += 1) {
    let runColor = at(r, 0);
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      const v = at(r, c);
      if (v === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = v;
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = at(0, c);
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      const v = at(r, c);
      if (v === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = v;
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) {
        penalty += 3;
      }
    }
  }

  // Rule 4: balance of dark modules
  let dark = 0;
  for (let i = 0; i < modules.length; i += 1) {
    if (modules[i] === 1) dark += 1;
  }
  const percent = (dark * 100) / (size * size);
  const k = Math.floor(Math.abs(percent - 50) / 5);
  penalty += k * 10;

  return penalty;
}

export interface QrCodeMatrix {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly modules: Uint8Array;
}

export interface QrSvgRenderOptions {
  /** Quiet zone in modules around the QR code (ISO/IEC 18004 recommends 4). Clamped to 2..8. */
  readonly quietZone?: number;
  /** Rendered pixel width/height attribute on `<svg>`. Clamped to 64..2048 (default 256). */
  readonly pixelSize?: number;
  /** Accessible `aria-label` text (sanitized). */
  readonly label?: string;
  /** Foreground hex color (`#rrggbb`, default `#182522`). */
  readonly foreground?: string;
  /** Background hex color (`#rrggbb`, default `#ffffff`). */
  readonly background?: string;
}

export function normalizeQrHexColor(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

export function normalizeQrQuietZone(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_QR_QUIET_ZONE;
  return Math.max(2, Math.min(8, Math.trunc(raw)));
}

/**
 * Encodes an arbitrary UTF-8 string into an ISO/IEC 18004 QR Code matrix (EC Level M).
 */
export function generateQrMatrix(text: string): QrCodeMatrix {
  if (!text || text.length === 0) {
    throw new Error("QR payload must be a non-empty string.");
  }

  const bytes = new TextEncoder().encode(text);
  const spec = selectQrSpec(bytes.length);
  const dataCodewords = encodeDataCodewords(bytes, spec);
  const allCodewords = interleaveCodewords(dataCodewords, spec);

  const size = spec.size;
  const baseModules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  const setFn = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    baseModules[r * size + c] = dark ? 1 : 0;
    isFunction[r * size + c] = 1;
  };

  // 1. Finder patterns + 1-module separators
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inOuter &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFn(r, c, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 2. Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // 3. Alignment patterns
  const centers = spec.alignmentCenters;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      const isCornerOverlap =
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0);
      if (isCornerOverlap) continue;
      const cr = centers[i] ?? 0;
      const cc = centers[j] ?? 0;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(cr + dr, cc + dc, dist === 0 || dist === 2);
        }
      }
    }
  }

  // 4. Reserve format information areas + fixed dark module
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFn(8, i, false);
      setFn(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFn(8, size - 1 - i, false);
  }
  for (let i = 0; i < 7; i += 1) {
    setFn(size - 1 - i, 8, false);
  }
  setFn(4 * spec.version + 9, 8, true);

  // 5. Version information (Version >= 7)
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  // 6. Place data bits in upward/downward 2-column zigzag
  let bitIdx = 0;
  const totalBits = allCodewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const col = right - dx;
        const pos = row * size + col;
        if (isFunction[pos] === 1) continue;
        let dark = false;
        if (bitIdx < totalBits) {
          const byte = allCodewords[bitIdx >>> 3] ?? 0;
          dark = ((byte >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx += 1;
        }
        baseModules[pos] = dark ? 1 : 0;
      }
    }
    upward = !upward;
  }

  // 7. Evaluate all 8 masks and choose lowest penalty
  const writeFormat = (buf: Uint8Array, mask: number) => {
    const fmt = computeFormatBits(mask);
    for (let i = 0; i <= 5; i += 1) {
      buf[8 * size + i] = (fmt >>> (14 - i)) & 1;
    }
    buf[8 * size + 7] = (fmt >>> 8) & 1;
    buf[8 * size + 8] = (fmt >>> 7) & 1;
    buf[7 * size + 8] = (fmt >>> 6) & 1;
    for (let i = 0; i <= 5; i += 1) {
      buf[(5 - i) * size + 8] = (fmt >>> (5 - i)) & 1;
    }

    for (let i = 0; i < 8; i += 1) {
      buf[8 * size + (size - 1 - i)] = (fmt >>> i) & 1;
    }
    for (let i = 0; i < 7; i += 1) {
      buf[(size - 1 - i) * size + 8] = (fmt >>> (14 - i)) & 1;
    }
    buf[(4 * spec.version + 9) * size + 8] = 1;
  };

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestModules = new Uint8Array(size * size);

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = new Uint8Array(baseModules);
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const pos = r * size + c;
        if (isFunction[pos] === 1) continue;
        if (applyMaskPredicate(mask, r, c)) {
          candidate[pos] = (candidate[pos] ?? 0) ^ 1;
        }
      }
    }
    writeFormat(candidate, mask);
    const score = scorePenalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestModules = candidate;
    }
  }

  return {
    version: spec.version,
    size,
    mask: bestMask,
    modules: bestModules,
  };
}

/**
 * Builds the SVG `<path d="...">` string for a QR matrix using horizontal run-length
 * coalescing so the vector output stays crisp and compact.
 */
export function buildQrSvgPathData(
  matrix: QrCodeMatrix,
  quietZone: number = DEFAULT_QR_QUIET_ZONE,
): string {
  const qz = normalizeQrQuietZone(quietZone);
  const parts: string[] = [];
  for (let r = 0; r < matrix.size; r += 1) {
    let c = 0;
    while (c < matrix.size) {
      if (matrix.modules[r * matrix.size + c] === 1) {
        const start = c;
        while (c < matrix.size && matrix.modules[r * matrix.size + c] === 1) {
          c += 1;
        }
        const runLen = c - start;
        parts.push(`M${start + qz},${r + qz}h${runLen}v1h-${runLen}z`);
      } else {
        c += 1;
      }
    }
  }
  return parts.join("");
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders a deterministic, accessible, self-contained SVG QR code with a quiet zone
 * (ISO/IEC 18004) and zero external references.
 */
export function renderQrSvg(
  textOrMatrix: string | QrCodeMatrix,
  options: QrSvgRenderOptions = {},
): string {
  const matrix = typeof textOrMatrix === "string" ? generateQrMatrix(textOrMatrix) : textOrMatrix;
  const quietZone = normalizeQrQuietZone(options.quietZone);
  const totalModules = matrix.size + quietZone * 2;
  const pixelSize =
    typeof options.pixelSize === "number" && Number.isFinite(options.pixelSize)
      ? Math.max(64, Math.min(2048, Math.trunc(options.pixelSize)))
      : 256;
  const fg = normalizeQrHexColor(options.foreground, DEFAULT_QR_FOREGROUND);
  const bg = normalizeQrHexColor(options.background, DEFAULT_QR_BACKGROUND);
  const rawLabel = (options.label ?? "Kode QR situs PunyaSitus").trim() || "Kode QR situs PunyaSitus";
  const safeLabel = escapeXmlAttr(rawLabel);
  const pathData = buildQrSvgPathData(matrix, quietZone);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalModules} ${totalModules}" width="${pixelSize}" height="${pixelSize}" role="img" aria-label="${safeLabel}" shape-rendering="crispEdges"><title>${safeLabel}</title><rect width="${totalModules}" height="${totalModules}" fill="${bg}"/><path d="${pathData}" fill="${fg}"/></svg>`;
}
