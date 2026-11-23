/**
 * Deterministic binary video, poster, and WebVTT test fixtures for TASK-060.
 * Zero external assets or network calls; runs identically in Node and Cloudflare `workerd`.
 */

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function u32be(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, false);
  return b;
}

function u16be(value: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value & 0xffff, false);
  return b;
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function makeBmffBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength, false);
  out.set(ascii(type.slice(0, 4)), 4);
  out.set(payload, 8);
  return out;
}

export interface SyntheticIsoBmffOptions {
  readonly brand?: "mp4" | "mov";
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly durationSeconds?: number;
  readonly videoCodec?: string; // e.g. "avc1", "hvc1", "vp09"
  readonly audioCodec?: string | null; // e.g. "mp4a", "Opus", null
  readonly moovFirst?: boolean;
  readonly includeLocationMetadata?: boolean;
  readonly targetTotalBytes?: number;
  /** Optional extra video track dimensions to test multi-video-track & oversized secondary track guards. */
  readonly extraVideoTrack?: { readonly width: number; readonly height: number; readonly fps?: number } | null;
  /** Optional auxiliary/timed-metadata track handler fourcc (e.g. "mebx", "meta", "gps ", "tmcd"). */
  readonly auxiliaryTrackHandler?: string | null;
  /** Optional fragmented MP4 flags (`mvex` inside `moov` and/or top-level `moof` box). */
  readonly fragmented?: boolean;
}

/**
 * Builds a structurally valid MP4 or QuickTime MOV binary with real `ftyp`, `moov`
 * (`mvhd`, video `trak` with `tkhd`/`mdia`/`mdhd`/`hdlr`/`minf`/`stbl`/`stsd`/`stts`/`stco`,
 * optional audio `trak`, optional `udta` GPS location metadata), and `mdat`.
 *
 * When `targetTotalBytes` is specified (e.g., `10_000_000` or `10_000_001`), sizes
 * `mdat` to produce the EXACT requested total byte length while keeping `stco` chunk
 * offsets pointing to the true start of the `mdat` payload!
 */
export function buildSyntheticIsoBmffVideo(options: SyntheticIsoBmffOptions = {}): Uint8Array {
  const brand = options.brand ?? "mp4";
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const fps = options.fps ?? 30;
  const durationSeconds = options.durationSeconds ?? 5;
  const videoCodec = options.videoCodec ?? (brand === "mov" ? "hvc1" : "avc1");
  const audioCodec = options.audioCodec === undefined ? "mp4a" : options.audioCodec;
  const moovFirst = options.moovFirst ?? false;
  const includeLocationMetadata = options.includeLocationMetadata ?? true;

  // 1. ftyp box
  const ftypPayload =
    brand === "mov"
      ? concat([ascii("qt  "), u32be(0x00000200), ascii("qt  ")])
      : concat([ascii("isom"), u32be(0x00000200), ascii("isom"), ascii("iso2"), ascii("mp41")]);
  const ftyp = makeBmffBox("ftyp", ftypPayload);

  // 2. Build moov helper that accepts the exact mdat payload offset for `stco`
  const buildMoovWithChunkOffset = (mdatPayloadOffset: number): Uint8Array => {
    const timescale = 30_000;
    const durationTicks = Math.max(1, Math.round(durationSeconds * timescale));
    const sampleCount = Math.max(1, Math.round(durationSeconds * fps));
    const sampleDelta = Math.max(1, Math.round(timescale / fps));

    // mvhd (version 0, 96-byte payload)
    const mvhdPayload = new Uint8Array(96);
    const mvhdView = new DataView(mvhdPayload.buffer);
    mvhdView.setUint32(12, timescale, false);
    mvhdView.setUint32(16, durationTicks, false);
    mvhdView.setUint32(20, 0x00010000, false); // rate 1.0
    mvhdView.setUint16(24, 0x0100, false); // volume 1.0
    const mvhd = makeBmffBox("mvhd", mvhdPayload);

    // Video trak
    const tkhdPayload = new Uint8Array(84);
    const tkhdView = new DataView(tkhdPayload.buffer);
    tkhdView.setUint32(0, 0x00000003, false); // flags enabled + in_movie
    tkhdView.setUint32(12, 1, false); // track_id = 1
    tkhdView.setUint32(20, durationTicks, false);
    tkhdView.setUint32(76, (width << 16) >>> 0, false);
    tkhdView.setUint32(80, (height << 16) >>> 0, false);
    const tkhd = makeBmffBox("tkhd", tkhdPayload);

    const mdhdPayload = new Uint8Array(24);
    const mdhdView = new DataView(mdhdPayload.buffer);
    mdhdView.setUint32(12, timescale, false);
    mdhdView.setUint32(16, sampleCount * sampleDelta, false);
    const mdhd = makeBmffBox("mdhd", mdhdPayload);

    const hdlrVideoPayload = concat([
      new Uint8Array(8),
      ascii("vide"),
      new Uint8Array(12),
      ascii("VideoHandler\0"),
    ]);
    const hdlrVideo = makeBmffBox("hdlr", hdlrVideoPayload);

    // VisualSampleEntry (78 bytes payload)
    const visualSamplePayload = new Uint8Array(78);
    const vsView = new DataView(visualSamplePayload.buffer);
    vsView.setUint16(6, 1, false); // data_reference_index
    vsView.setUint16(24, width, false);
    vsView.setUint16(26, height, false);
    vsView.setUint32(28, 0x00480000, false); // horizresolution 72 dpi
    vsView.setUint32(32, 0x00480000, false); // vertresolution 72 dpi
    vsView.setUint16(40, 1, false); // frame_count
    vsView.setUint16(74, 0x0018, false); // depth 24
    vsView.setUint16(76, 0xffff, false);
    const codecEntry = makeBmffBox(videoCodec, visualSamplePayload);

    const stsdVideo = makeBmffBox("stsd", concat([u32be(0), u32be(1), codecEntry]));
    const sttsVideo = makeBmffBox(
      "stts",
      concat([u32be(0), u32be(1), u32be(sampleCount), u32be(sampleDelta)]),
    );
    const stcoVideo = makeBmffBox("stco", concat([u32be(0), u32be(1), u32be(mdatPayloadOffset)]));

    const stblVideo = makeBmffBox("stbl", concat([stsdVideo, sttsVideo, stcoVideo]));
    const minfVideo = makeBmffBox("minf", stblVideo);
    const mdiaVideo = makeBmffBox("mdia", concat([mdhd, hdlrVideo, minfVideo]));

    const trakChildren: Uint8Array[] = [tkhd, mdiaVideo];
    if (includeLocationMetadata) {
      const trakUdta = makeBmffBox("udta", ascii("TRAK_DEVICE_SERIAL_SECRET_12345"));
      trakChildren.push(trakUdta);
    }
    const videoTrak = makeBmffBox("trak", concat(trakChildren));

    const moovChildren: Uint8Array[] = [mvhd, videoTrak];

    if (audioCodec) {
      const audioTkhd = makeBmffBox("tkhd", new Uint8Array(84));
      const audioMdhd = makeBmffBox("mdhd", mdhdPayload);
      const hdlrAudio = makeBmffBox(
        "hdlr",
        concat([new Uint8Array(8), ascii("soun"), new Uint8Array(12), ascii("SoundHandler\0")]),
      );
      const audioSamplePayload = new Uint8Array(28);
      new DataView(audioSamplePayload.buffer).setUint16(6, 1, false);
      const audioEntry = makeBmffBox(audioCodec, audioSamplePayload);
      const stsdAudio = makeBmffBox("stsd", concat([u32be(0), u32be(1), audioEntry]));
      const stcoAudio = makeBmffBox("stco", concat([u32be(0), u32be(1), u32be(mdatPayloadOffset)]));
      const stblAudio = makeBmffBox("stbl", concat([stsdAudio, stcoAudio]));
      const minfAudio = makeBmffBox("minf", stblAudio);
      const mdiaAudio = makeBmffBox("mdia", concat([audioMdhd, hdlrAudio, minfAudio]));
      moovChildren.push(makeBmffBox("trak", concat([audioTkhd, mdiaAudio])));
    }

    if (options.extraVideoTrack) {
      const ew = options.extraVideoTrack.width;
      const eh = options.extraVideoTrack.height;
      const efps = options.extraVideoTrack.fps ?? fps;
      const eSampleDelta = Math.max(1, Math.round(timescale / efps));
      const eSampleCount = Math.max(1, Math.round(durationSeconds * efps));
      const eTkhdPayload = new Uint8Array(84);
      const eTkhdView = new DataView(eTkhdPayload.buffer);
      eTkhdView.setUint32(12, 3, false);
      eTkhdView.setUint32(76, (ew << 16) >>> 0, false);
      eTkhdView.setUint32(80, (eh << 16) >>> 0, false);
      const eVsPayload = new Uint8Array(78);
      const eVsView = new DataView(eVsPayload.buffer);
      eVsView.setUint16(6, 1, false);
      eVsView.setUint16(24, ew, false);
      eVsView.setUint16(26, eh, false);
      const eStsd = makeBmffBox("stsd", concat([u32be(0), u32be(1), makeBmffBox(videoCodec, eVsPayload)]));
      const eStts = makeBmffBox("stts", concat([u32be(0), u32be(1), u32be(eSampleCount), u32be(eSampleDelta)]));
      const eStco = makeBmffBox("stco", concat([u32be(0), u32be(1), u32be(mdatPayloadOffset)]));
      const eMdia = makeBmffBox(
        "mdia",
        concat([mdhd, hdlrVideo, makeBmffBox("minf", makeBmffBox("stbl", concat([eStsd, eStts, eStco])))]),
      );
      moovChildren.push(makeBmffBox("trak", concat([makeBmffBox("tkhd", eTkhdPayload), eMdia])));
    }

    if (options.auxiliaryTrackHandler) {
      const auxHandler = options.auxiliaryTrackHandler.slice(0, 4).padEnd(4, " ");
      const auxHdlr = makeBmffBox(
        "hdlr",
        concat([new Uint8Array(8), ascii(auxHandler), new Uint8Array(12), ascii("MetaHandler\0")]),
      );
      const auxStsd = makeBmffBox("stsd", concat([u32be(0), u32be(1), makeBmffBox("mebx", new Uint8Array(16))]));
      const auxStco = makeBmffBox("stco", concat([u32be(0), u32be(1), u32be(mdatPayloadOffset)]));
      const auxMdia = makeBmffBox(
        "mdia",
        concat([mdhd, auxHdlr, makeBmffBox("minf", makeBmffBox("stbl", concat([auxStsd, auxStco])))]),
      );
      moovChildren.push(makeBmffBox("trak", concat([makeBmffBox("tkhd", new Uint8Array(84)), auxMdia])));
    }

    if (options.fragmented) {
      moovChildren.push(makeBmffBox("mvex", new Uint8Array(16)));
    }

    if (includeLocationMetadata) {
      // Simulate real iPhone/Android GPS + Apple metadata inside moov/udta + moov/meta
      const gpsBox = makeBmffBox("©xyz", ascii("-6.2088+106.8456/GPS_PRIVATE_COORDS"));
      const udta = makeBmffBox("udta", gpsBox);
      const meta = makeBmffBox("meta", concat([u32be(0), ascii("PRIVATE_CAMERA_META_EXIF")]));
      moovChildren.push(udta, meta);
    }

    return makeBmffBox("moov", concat(moovChildren));
  };

  // Measure moov size first (fixed size regardless of offset value)
  const dummyMoov = buildMoovWithChunkOffset(0);
  const overhead = ftyp.byteLength + dummyMoov.byteLength + 8; // +8 for mdat box header
  const desiredPayloadLen =
    options.targetTotalBytes !== undefined
      ? Math.max(16, options.targetTotalBytes - overhead)
      : 64;

  const mdatPayload = new Uint8Array(desiredPayloadLen);
  // Stamp recognizable marker at start of mdat payload so stco offset verification can prove exact byte accuracy!
  mdatPayload.set(ascii("PS_MDAT_START!"), 0);
  const mdat = makeBmffBox("mdat", mdatPayload);
  const moof = options.fragmented ? makeBmffBox("moof", new Uint8Array(16)) : null;

  if (moovFirst) {
    const mdatPayloadOffset = ftyp.byteLength + dummyMoov.byteLength + (moof ? moof.byteLength : 0) + 8;
    const realMoov = buildMoovWithChunkOffset(mdatPayloadOffset);
    return moof ? concat([ftyp, realMoov, moof, mdat]) : concat([ftyp, realMoov, mdat]);
  }

  const mdatPayloadOffset = ftyp.byteLength + 8;
  const realMoov = buildMoovWithChunkOffset(mdatPayloadOffset);
  return moof ? concat([ftyp, mdat, moof, realMoov]) : concat([ftyp, mdat, realMoov]);
}

function ebmlVintSize(size: number): Uint8Array {
  if (size < 0x7f) {
    return new Uint8Array([0x80 | size]);
  }
  if (size < 0x3fff) {
    return new Uint8Array([0x40 | ((size >> 8) & 0x3f), size & 0xff]);
  }
  if (size < 0x1fffff) {
    return new Uint8Array([
      0x20 | ((size >> 16) & 0x1f),
      (size >> 8) & 0xff,
      size & 0xff,
    ]);
  }
  return new Uint8Array([
    0x10 | ((size >> 24) & 0x0f),
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
  ]);
}

function ebmlElem(idBytes: readonly number[], payload: Uint8Array): Uint8Array {
  return concat([new Uint8Array(idBytes), ebmlVintSize(payload.byteLength), payload]);
}

function ebmlUintBytes(value: number): Uint8Array {
  if (value <= 0xff) return new Uint8Array([value]);
  if (value <= 0xffff) return u16be(value);
  return u32be(value);
}

/**
 * Builds a structurally valid WebM (EBML) binary with `DocType="webm"`, `Info`,
 * `Tracks` (`V_VP9` + `A_OPUS` with `PixelWidth`, `PixelHeight`, `DefaultDuration`),
 * and `Cluster` — optionally padded to exact `targetTotalBytes`.
 */
export function buildSyntheticWebmVideo(options?: {
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly durationSeconds?: number;
  readonly docType?: string;
  readonly targetTotalBytes?: number;
}): Uint8Array {
  const width = options?.width ?? 1280;
  const height = options?.height ?? 720;
  const fps = options?.fps ?? 30;
  const durationSeconds = options?.durationSeconds ?? 4;
  const docType = options?.docType ?? "webm";

  const ebmlHeader = ebmlElem(
    [0x1a, 0x45, 0xdf, 0xa3],
    concat([
      ebmlElem([0x42, 0x86], new Uint8Array([1])), // EBMLVersion
      ebmlElem([0x42, 0x82], ascii(docType)), // DocType
    ]),
  );

  const durBuf = new Uint8Array(4);
  new DataView(durBuf.buffer).setFloat32(0, durationSeconds * 1000, false); // ms when TimestampScale = 1_000_000 ns
  const info = ebmlElem(
    [0x15, 0x49, 0xa9, 0x66],
    concat([
      ebmlElem([0x2a, 0xd7, 0xb1], ebmlUintBytes(1_000_000)), // TimestampScale
      ebmlElem([0x44, 0x89], durBuf), // Duration
    ]),
  );

  const defaultDurationNs = Math.max(1, Math.round(1_000_000_000 / fps));
  const videoSub = ebmlElem(
    [0xe0],
    concat([
      ebmlElem([0xb0], ebmlUintBytes(width)), // PixelWidth
      ebmlElem([0xba], ebmlUintBytes(height)), // PixelHeight
    ]),
  );

  const videoTrackEntry = ebmlElem(
    [0xae],
    concat([
      ebmlElem([0x83], new Uint8Array([1])), // TrackType = video
      ebmlElem([0x86], ascii("V_VP9")), // CodecID
      ebmlElem([0x23, 0xe3, 0x83], ebmlUintBytes(defaultDurationNs)), // DefaultDuration
      videoSub,
    ]),
  );

  const audioTrackEntry = ebmlElem(
    [0xae],
    concat([
      ebmlElem([0x83], new Uint8Array([2])), // TrackType = audio
      ebmlElem([0x86], ascii("A_OPUS")),
    ]),
  );

  const tracks = ebmlElem([0x16, 0x54, 0xae, 0x6b], concat([videoTrackEntry, audioTrackEntry]));

  const buildWithClusterLen = (clusterPayloadLen: number): Uint8Array => {
    const clusterPayload = new Uint8Array(clusterPayloadLen);
    clusterPayload.set(ascii("WEBM_FRAME"), 0);
    const cluster = ebmlElem([0x1f, 0x43, 0xb6, 0x75], clusterPayload);
    const segment = ebmlElem([0x18, 0x53, 0x80, 0x67], concat([info, tracks, cluster]));
    return concat([ebmlHeader, segment]);
  };

  if (options?.targetTotalBytes === undefined) {
    return buildWithClusterLen(32);
  }

  // Compute exact cluster payload size accounting for EBML VINT size byte width
  const baseline = buildWithClusterLen(16);
  let guess = Math.max(16, options.targetTotalBytes - baseline.byteLength + 16);
  for (let i = 0; i < 6; i += 1) {
    const candidate = buildWithClusterLen(guess);
    const diff = options.targetTotalBytes - candidate.byteLength;
    if (diff === 0) return candidate;
    guess = Math.max(16, guess + diff);
  }
  return buildWithClusterLen(guess);
}

export function makeValidWebpVp8X(width = 640, height = 360, totalSize = 256): Uint8Array {
  const size = Math.max(30, totalSize);
  const buf = new Uint8Array(size);
  buf.set(ascii("RIFF"), 0);
  const view = new DataView(buf.buffer);
  view.setUint32(4, size - 8, true);
  buf.set(ascii("WEBP"), 8);
  buf.set(ascii("VP8X"), 12);
  view.setUint32(16, 10, true);
  const wMinus1 = Math.max(0, width - 1);
  const hMinus1 = Math.max(0, height - 1);
  buf[24] = wMinus1 & 0xff;
  buf[25] = (wMinus1 >> 8) & 0xff;
  buf[26] = (wMinus1 >> 16) & 0xff;
  buf[27] = hMinus1 & 0xff;
  buf[28] = (hMinus1 >> 8) & 0xff;
  buf[29] = (hMinus1 >> 16) & 0xff;
  return buf;
}

export function readStcoOffsetsFromMp4(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 16 <= bytes.byteLength; i += 1) {
    if (
      bytes[i + 4] === 0x73 &&
      bytes[i + 5] === 0x74 &&
      bytes[i + 6] === 0x63 &&
      bytes[i + 7] === 0x6f
    ) {
      const boxSize = view.getUint32(i, false);
      const count = view.getUint32(i + 12, false);
      if (boxSize === 16 + count * 4 && i + boxSize <= bytes.byteLength) {
        for (let k = 0; k < count; k += 1) {
          offsets.push(view.getUint32(i + 16 + k * 4, false));
        }
      }
    }
  }
  return offsets;
}

export const SAMPLE_VALID_WEBVTT = `WEBVTT

00:00:00.500 --> 00:00:03.200
Selamat datang di ruang produksi kami di Jakarta.

00:00:03.500 --> 00:00:06.000 align:center
Semua proyek dikerjakan sesuai standar kualitas.
`;

export const SAMPLE_XSS_WEBVTT = `WEBVTT

NOTE komentar internal yang harus dibuang

00:00:00.000 --> 00:00:02.000
<script>alert("xss")</script><b>Halo</b> pengunjung <img src=x onerror=alert(1)>kami.
`;
