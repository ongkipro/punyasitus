/**
 * Scale-to-zero Cloudflare Container placeholder (`VideoTranscoder`, ADR-0009).
 * Full `ffmpeg` MOV/WebM container binding and Dockerfile arrive in TASK-060.
 */
export interface VideoTranscodeRequest {
  readonly tenantId: string;
  readonly sourceKey: string;
  readonly targetKey: string;
}

export class VideoTranscoderStub {
  readonly kind = "video-transcoder-stub" as const;

  describe(req: VideoTranscodeRequest): string {
    return `${req.tenantId}:${req.sourceKey}->${req.targetKey}`;
  }
}
