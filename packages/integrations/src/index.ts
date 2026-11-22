/**
 * Server-only provider integration boundaries.
 * Concrete provider adapters live in one folder per provider (e.g. src/autolaris/, src/email/).
 */
export interface OutboundEmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailSendResult {
  readonly provider: "cloudflare-email" | "resend" | "local-sink";
  readonly messageId: string;
}

export interface EmailPort {
  send(message: OutboundEmailMessage): Promise<EmailSendResult>;
}

export function assertFixedProviderOrigin(origin: string): URL {
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:") {
    throw new Error(`Provider origin must use HTTPS: ${origin}`);
  }
  return parsed;
}
