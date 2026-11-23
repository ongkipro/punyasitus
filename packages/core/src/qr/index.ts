export {
  DEFAULT_QR_BACKGROUND,
  DEFAULT_QR_FOREGROUND,
  DEFAULT_QR_QUIET_ZONE,
  MAX_QR_PAYLOAD_BYTES,
  buildQrSvgPathData,
  generateQrMatrix,
  normalizeQrHexColor,
  normalizeQrQuietZone,
  renderQrSvg,
  type QrCodeMatrix,
  type QrSvgRenderOptions,
} from "./encoder.ts";

export {
  DEFAULT_QR_PNG_MODULE_SIZE,
  PNG_SIGNATURE,
  renderQrPngBytes,
  type QrPngRenderOptions,
} from "./png.ts";

export {
  QR_FORMATS,
  QR_TARGET_KINDS,
  QR_UTM_QUERY_KEY,
  QR_UTM_QUERY_VALUE,
  QrDraftNotAllowedError,
  QrValidationError,
  buildCanonicalQrTargetUrl,
  buildQrDownloadFilename,
  buildTenantQrApiUrl,
  normalizeVerifiedPrimaryOrigin,
  type CanonicalQrTargetInput,
  type QrFilenameInput,
  type QrFormat,
  type QrResourceStatus,
  type QrTargetKind,
} from "./canonical.ts";

export {
  QR_SCAN_CHANNEL_KEY,
  QR_SCAN_CHANNEL_LABEL_ID,
  classifyQrScanVisit,
  countQrScanVisits,
  type QrScanClassification,
  type QrScanCountSummary,
  type QrScanPathCount,
  type QrScanVisitSourceInput,
} from "./insights.ts";
