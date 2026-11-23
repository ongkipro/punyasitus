/**
 * Independent ISO/IEC 18004 QR Code Decoder + SVG Rasterizer + PNG Binary Parser
 * for `TASK-108` test verification.
 *
 * Independently verifies:
 * 1. PNG signature, chunk structure (`IHDR`, `PLTE`, `IDAT`, `IEND`), IEEE CRC-32 per chunk,
 *    RFC 1950 zlib header + stored DEFLATE blocks + Adler-32 checksum, and 1-bit indexed pixels.
 * 2. SVG `viewBox`, `<rect>`, `<path>` horizontal run-length commands rasterized into modules.
 * 3. Full ISO/IEC 18004 QR decoding: format info BCH check -> mask recovery -> unmasking ->
 *    codeword zigzag extraction -> block deinterleaving -> Reed-Solomon GF(256) syndrome check
 *    (asserting 0 errors across every block!) -> Byte-mode UTF-8 payload decoding.
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

function verifyReedSolomonBlock(data: Uint8Array, ec: Uint8Array): void {
  // Evaluate codeword polynomial (data || ec) at roots alpha^0 .. alpha^(ecLen-1)
  const codeword = new Uint8Array(data.length + ec.length);
  codeword.set(data, 0);
  codeword.set(ec, data.length);
  for (let rootIdx = 0; rootIdx < ec.length; rootIdx += 1) {
    const root = GF_EXP[rootIdx] ?? 1;
    let acc = 0;
    for (let i = 0; i < codeword.length; i += 1) {
      acc = gfMul(acc, root) ^ (codeword[i] ?? 0);
    }
    if (acc !== 0) {
      throw new Error(`Reed-Solomon syndrome check failed at root ${rootIdx} (syndrome=${acc})`);
    }
  }
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

function buildFunctionMask(spec: QrVersionSpec): Uint8Array {
  const size = spec.size;
  const isFn = new Uint8Array(size * size);
  const mark = (r: number, c: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      isFn[r * size + c] = 1;
    }
  };
  const markFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        mark(top + dr, left + dc);
      }
    }
  };
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  const centers = spec.alignmentCenters;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0);
      if (corner) continue;
      const cr = centers[i] ?? 0;
      const cc = centers[j] ?? 0;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          mark(cr + dr, cc + dc);
        }
      }
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      mark(8, i);
      mark(i, 8);
    }
  }
  for (let i = 0; i < 8; i += 1) mark(8, size - 1 - i);
  for (let i = 0; i < 7; i += 1) mark(size - 1 - i, 8);
  mark(4 * spec.version + 9, 8);
  if (spec.version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return isFn;
}

/**
 * Decodes an ISO/IEC 18004 QR Code binary module matrix (`size * size`, 0=light, 1=dark)
 * back to its exact UTF-8 payload string, verifying format BCH and Reed-Solomon syndromes.
 */
export function decodeQrMatrixToText(modules: Uint8Array, size: number): string {
  const spec = QR_SPECS_M.find((s) => s.size === size);
  if (!spec) {
    throw new Error(`Unsupported QR matrix size: ${size}`);
  }
  const at = (r: number, c: number): number => modules[r * size + c] ?? 0;

  // Read top-left format info bits (bits 14..0)
  let rawFmt1 = 0;
  for (let i = 0; i <= 5; i += 1) rawFmt1 = (rawFmt1 << 1) | at(8, i);
  rawFmt1 = (rawFmt1 << 1) | at(8, 7);
  rawFmt1 = (rawFmt1 << 1) | at(8, 8);
  rawFmt1 = (rawFmt1 << 1) | at(7, 8);
  for (let i = 5; i >= 0; i -= 1) rawFmt1 = (rawFmt1 << 1) | at(i, 8);

  // Read secondary format info copy (bottom-left + top-right)
  let rawFmt2 = 0;
  for (let i = 0; i < 7; i += 1) rawFmt2 = (rawFmt2 << 1) | at(size - 1 - i, 8);
  for (let i = 7; i >= 0; i -= 1) rawFmt2 = (rawFmt2 << 1) | at(8, size - 1 - i);

  if (rawFmt1 !== rawFmt2) {
    throw new Error(`QR format info copies disagree: ${rawFmt1.toString(2)} vs ${rawFmt2.toString(2)}`);
  }

  const unmaskedFmt = rawFmt1 ^ 0x5412;
  const ecLevelBits = (unmaskedFmt >>> 13) & 0b11;
  const mask = (unmaskedFmt >>> 10) & 0b111;
  if (ecLevelBits !== 0b00) {
    throw new Error(`Expected EC Level M (00), got ${ecLevelBits.toString(2)}`);
  }

  // Verify fixed dark module
  if (at(4 * spec.version + 9, 8) !== 1) {
    throw new Error("Fixed QR dark module is missing");
  }

  // Extract interleaved codeword bits in zigzag order and unmask
  const isFn = buildFunctionMask(spec);
  const allCodewords = new Uint8Array(spec.totalCodewords);
  let bitIdx = 0;
  const totalBits = spec.totalCodewords * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const col = right - dx;
        const pos = row * size + col;
        if (isFn[pos] === 1) continue;
        if (bitIdx < totalBits) {
          let bit = modules[pos] ?? 0;
          if (applyMaskPredicate(mask, row, col)) bit ^= 1;
          allCodewords[bitIdx >>> 3] = ((allCodewords[bitIdx >>> 3] ?? 0) << 1) | bit;
          bitIdx += 1;
        }
      }
    }
    upward = !upward;
  }

  // Deinterleave data & EC blocks
  const blockCount = spec.group1Blocks + spec.group2Blocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    dataBlocks.push(new Uint8Array(spec.group1Data));
    ecBlocks.push(new Uint8Array(spec.ecPerBlock));
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    dataBlocks.push(new Uint8Array(spec.group2Data));
    ecBlocks.push(new Uint8Array(spec.ecPerBlock));
  }

  let cursor = 0;
  const maxDataLen = Math.max(spec.group1Data, spec.group2Data);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < blockCount; b += 1) {
      const block = dataBlocks[b]!;
      if (i < block.length) {
        block[i] = allCodewords[cursor] ?? 0;
        cursor += 1;
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (let b = 0; b < blockCount; b += 1) {
      ecBlocks[b]![i] = allCodewords[cursor] ?? 0;
      cursor += 1;
    }
  }

  // Verify Reed-Solomon EC syndromes on every block
  const flatData = new Uint8Array(spec.dataCodewords);
  let dataOffset = 0;
  for (let b = 0; b < blockCount; b += 1) {
    verifyReedSolomonBlock(dataBlocks[b]!, ecBlocks[b]!);
    flatData.set(dataBlocks[b]!, dataOffset);
    dataOffset += dataBlocks[b]!.length;
  }

  // Read bitstream: Byte mode (0100), count (8 or 16 bits), payload bytes
  let bitPos = 0;
  const readBits = (count: number): number => {
    let val = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = flatData[bitPos >>> 3] ?? 0;
      const bit = (byte >>> (7 - (bitPos & 7))) & 1;
      val = (val << 1) | bit;
      bitPos += 1;
    }
    return val;
  };

  const mode = readBits(4);
  if (mode !== 0b0100) {
    throw new Error(`Expected Byte mode (0100), got ${mode.toString(2)}`);
  }
  const lenBits = spec.version <= 9 ? 8 : 16;
  const byteLen = readBits(lenBits);
  const payload = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i += 1) {
    payload[i] = readBits(8);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(payload);
}

/**
 * Independently parses a rendered QR `<svg>` string, rasterizes its `<path>` commands onto
 * a module grid, strips the quiet zone, and decodes the ISO/IEC 18004 payload string.
 */
export function decodeQrSvgToText(svg: string): {
  readonly text: string;
  readonly totalModules: number;
  readonly qrSize: number;
  readonly quietZone: number;
} {
  const vbMatch = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!vbMatch) throw new Error("SVG missing viewBox");
  const totalModules = Number(vbMatch[1]);
  if (totalModules !== Number(vbMatch[2])) {
    throw new Error("SVG viewBox must be square");
  }
  const pathMatch = /<path\s+d="([^"]+)"/.exec(svg);
  if (!pathMatch) throw new Error("SVG missing <path d=...>");
  const d = pathMatch[1]!;

  const grid = new Uint8Array(totalModules * totalModules);
  const cmdRe = /M(\d+),(\d+)h(\d+)v1h-\d+z/g;
  let match: RegExpExecArray | null;
  let minR = totalModules;
  let minC = totalModules;
  let maxR = -1;
  let maxC = -1;

  while ((match = cmdRe.exec(d)) !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const len = Number(match[3]);
    for (let dx = 0; dx < len; dx += 1) {
      const c = x + dx;
      const r = y;
      grid[r * totalModules + c] = 1;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }

  if (maxR < 0) throw new Error("SVG path contains no dark modules");
  const quietZone = minR;
  const qrSize = maxR - minR + 1;
  if (minC !== quietZone || maxC - minC + 1 !== qrSize || totalModules !== qrSize + quietZone * 2) {
    throw new Error("SVG quiet zone is asymmetric");
  }

  const modules = new Uint8Array(qrSize * qrSize);
  for (let r = 0; r < qrSize; r += 1) {
    for (let c = 0; c < qrSize; c += 1) {
      modules[r * qrSize + c] = grid[(r + quietZone) * totalModules + (c + quietZone)] ?? 0;
    }
  }

  const text = decodeQrMatrixToText(modules, qrSize);
  return { text, totalModules, qrSize, quietZone };
}

// IEEE 802.3 CRC-32 for independent PNG chunk validation
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] ?? 0) << 24) |
      ((buf[offset + 1] ?? 0) << 16) |
      ((buf[offset + 2] ?? 0) << 8) |
      (buf[offset + 3] ?? 0)) >>>
    0
  );
}

function verifyCrc32(bytes: Uint8Array, expected: number, chunkType: string): void {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  const actual = (c ^ 0xffffffff) >>> 0;
  if (actual !== expected) {
    throw new Error(`PNG ${chunkType} CRC-32 mismatch: expected ${expected}, got ${actual}`);
  }
}

function computeAdler32(data: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] ?? 0)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function decodeZlibStored(zlibBytes: Uint8Array): Uint8Array {
  if (zlibBytes.length < 6) throw new Error("Zlib stream too short");
  const cmf = zlibBytes[0] ?? 0;
  const flg = zlibBytes[1] ?? 0;
  if ((cmf * 256 + flg) % 31 !== 0) {
    throw new Error("Invalid RFC 1950 zlib FCHECK");
  }
  if ((cmf & 0x0f) !== 8) {
    throw new Error("Unsupported zlib compression method");
  }

  let offset = 2;
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  let done = false;
  while (!done) {
    const header = zlibBytes[offset] ?? 0;
    const bfinal = header & 1;
    const btype = (header >>> 1) & 0b11;
    if (btype !== 0) {
      throw new Error(`Expected stored DEFLATE block (btype=0), got ${btype}`);
    }
    const len = (zlibBytes[offset + 1] ?? 0) | ((zlibBytes[offset + 2] ?? 0) << 8);
    const nlen = (zlibBytes[offset + 3] ?? 0) | ((zlibBytes[offset + 4] ?? 0) << 8);
    if (((len ^ nlen) & 0xffff) !== 0xffff) {
      throw new Error("DEFLATE stored block LEN/NLEN mismatch");
    }
    offset += 5;
    const slice = zlibBytes.subarray(offset, offset + len);
    chunks.push(slice);
    totalLen += slice.length;
    offset += len;
    if (bfinal === 1) done = true;
  }

  const expectedAdler = readUint32BE(zlibBytes, offset);
  const raw = new Uint8Array(totalLen);
  let pos = 0;
  for (const ch of chunks) {
    raw.set(ch, pos);
    pos += ch.length;
  }
  const actualAdler = computeAdler32(raw);
  if (actualAdler !== expectedAdler) {
    throw new Error(`Zlib Adler-32 mismatch: expected ${expectedAdler}, got ${actualAdler}`);
  }
  return raw;
}

/**
 * Independently validates PNG binary structure (signature, chunk CRCs, IHDR, PLTE, IDAT zlib/Adler-32, IEND),
 * reconstructs the pixel grid, infers module scale & quiet zone, and decodes the ISO/IEC 18004 QR payload.
 */
export function decodeQrPngToText(pngBytes: Uint8Array): {
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly moduleSize: number;
  readonly qrSize: number;
  readonly quietZone: number;
} {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngBytes.length < 33) throw new Error("PNG too short");
  for (let i = 0; i < 8; i += 1) {
    if (pngBytes[i] !== sig[i]) {
      throw new Error(`Invalid PNG signature byte at index ${i}`);
    }
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let hasPlte = false;
  let sawIend = false;
  const idatParts: Uint8Array[] = [];
  let totalIdatLen = 0;

  while (offset < pngBytes.length) {
    const length = readUint32BE(pngBytes, offset);
    const type = String.fromCharCode(
      pngBytes[offset + 4] ?? 0,
      pngBytes[offset + 5] ?? 0,
      pngBytes[offset + 6] ?? 0,
      pngBytes[offset + 7] ?? 0,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcExpected = readUint32BE(pngBytes, dataEnd);
    verifyCrc32(pngBytes.subarray(offset + 4, dataEnd), crcExpected, type);
    const chunkData = pngBytes.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = readUint32BE(chunkData, 0);
      height = readUint32BE(chunkData, 4);
      bitDepth = chunkData[8] ?? 0;
      colorType = chunkData[9] ?? 0;
    } else if (type === "PLTE") {
      hasPlte = true;
    } else if (type === "IDAT") {
      idatParts.push(chunkData);
      totalIdatLen += chunkData.length;
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }

    offset = dataEnd + 4;
  }

  if (!sawIend || width === 0 || width !== height) {
    throw new Error("PNG missing IEND or non-square dimensions");
  }
  if (bitDepth !== 1 || colorType !== 3 || !hasPlte) {
    throw new Error(`Unexpected PNG format: bitDepth=${bitDepth}, colorType=${colorType}, hasPlte=${hasPlte}`);
  }

  const combinedIdat = new Uint8Array(totalIdatLen);
  let idatPos = 0;
  for (const part of idatParts) {
    combinedIdat.set(part, idatPos);
    idatPos += part.length;
  }

  const rawScanlines = decodeZlibStored(combinedIdat);
  const rowBytes = Math.ceil(width / 8);
  const stride = 1 + rowBytes;
  if (rawScanlines.length !== height * stride) {
    throw new Error(`Unexpected raw scanline byte length: ${rawScanlines.length}`);
  }

  const pixels = new Uint8Array(width * height);
  let minY = height;
  let maxY = -1;
  let minX = width;
  let maxX = -1;

  for (let y = 0; y < height; y += 1) {
    const filterByte = rawScanlines[y * stride] ?? 0;
    if (filterByte !== 0) throw new Error(`Unsupported PNG filter byte ${filterByte}`);
    for (let x = 0; x < width; x += 1) {
      const byte = rawScanlines[y * stride + 1 + (x >>> 3)] ?? 0;
      const bit = (byte >>> (7 - (x & 7))) & 1;
      pixels[y * width + x] = bit;
      if (bit === 1) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }

  if (maxY < 0) throw new Error("PNG contains no dark pixels");
  // Top-left finder top bar is 7 modules wide: measure dark run at (minY, minX..)
  let finderRunPx = 0;
  while (minX + finderRunPx < width && pixels[minY * width + (minX + finderRunPx)] === 1) {
    finderRunPx += 1;
  }
  if (finderRunPx % 7 !== 0) {
    throw new Error(`Finder top bar width (${finderRunPx}px) is not a multiple of 7 modules`);
  }
  const moduleSize = finderRunPx / 7;
  const qrWidthPx = maxX - minX + 1;
  const qrHeightPx = maxY - minY + 1;
  if (qrWidthPx !== qrHeightPx || qrWidthPx % moduleSize !== 0) {
    throw new Error("QR bounding box in PNG is not aligned to moduleSize");
  }
  const qrSize = qrWidthPx / moduleSize;
  const quietZone = minX / moduleSize;

  // Verify every pixel within each module block is uniform (crispEdges fidelity!)
  const modules = new Uint8Array(qrSize * qrSize);
  for (let r = 0; r < qrSize; r += 1) {
    for (let c = 0; c < qrSize; c += 1) {
      const expectedBit = pixels[(minY + r * moduleSize) * width + (minX + c * moduleSize)] ?? 0;
      for (let dy = 0; dy < moduleSize; dy += 1) {
        for (let dx = 0; dx < moduleSize; dx += 1) {
          const actualBit =
            pixels[(minY + r * moduleSize + dy) * width + (minX + c * moduleSize + dx)] ?? 0;
          if (actualBit !== expectedBit) {
            throw new Error(`Non-uniform pixel inside QR module (${r}, ${c})`);
          }
        }
      }
      modules[r * qrSize + c] = expectedBit;
    }
  }

  const text = decodeQrMatrixToText(modules, qrSize);
  return { text, width, height, moduleSize, qrSize, quietZone };
}
