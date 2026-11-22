import * as React from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          readonly sitekey: string;
          readonly theme?: "light" | "dark" | "auto";
          readonly language?: string;
          readonly action?: string;
          readonly callback?: (token: string) => void;
          readonly "expired-callback"?: () => void;
          readonly "error-callback"?: () => void;
        },
      ) => string;
      reset?: (widgetId?: string) => void;
      remove?: (widgetId?: string) => void;
    };
  }
}

const TURNSTILE_SCRIPT_ID = "ps-cf-turnstile-script";
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Crisp inline Google "G" SVG mark (no external CDN dependency).
 */
export function GoogleMark({ className = "size-4" }: { readonly className?: string }) {
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        className={className}
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="#4285F4"
          d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v3h3.87c2.26-2.08 3.57-5.15 3.57-8.64Z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.87-3c-1.07.72-2.44 1.15-4.06 1.15-3.12 0-5.77-2.11-6.72-4.95H1.28v3.1A12 12 0 0 0 12 24Z"
        />
        <path
          fill="#FBBC05"
          d="M5.28 14.29A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.38-2.29v-3.1H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l4-3.1Z"
        />
        <path
          fill="#EA4335"
          d="M12 4.76c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4 3.1C6.23 6.87 8.88 4.76 12 4.76Z"
        />
      </svg>
    </span>
  );
}

/**
 * Accessible hidden honeypot trap input (`hp_website`).
 * Zero-dimension and `aria-hidden` + `tabIndex={-1}` so screen readers, keyboard users,
 * and mobile touch-target layout audits ignore it while automated form-filling bots populate it.
 */
export function HoneypotField({
  value,
  onChange,
  id = "hp-website",
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly id?: string;
}) {
  return (
    <input
      id={id}
      name="hp_website"
      type="text"
      tabIndex={-1}
      autoComplete="off"
      aria-hidden="true"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="pointer-events-none absolute top-0 left-0 h-0 w-0 overflow-hidden border-0 p-0 opacity-0"
    />
  );
}

/**
 * Progressive Cloudflare Turnstile widget slot (`data-testid="turnstile-slot"`).
 * Renders the Turnstile widget ONLY when `siteKey` is configured; stays inert with
 * zero external requests or console errors in local/offline dev environments.
 */
export function TurnstileField({
  siteKey,
  action,
  onTokenChange,
}: {
  readonly siteKey?: string | null;
  readonly action: string;
  readonly onTokenChange: (token: string) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const widgetIdRef = React.useRef<string | null>(null);
  const onTokenChangeRef = React.useRef(onTokenChange);
  onTokenChangeRef.current = onTokenChange;

  const trimmedSiteKey = siteKey?.trim() ?? "";

  React.useEffect(() => {
    if (!trimmedSiteKey || typeof window === "undefined" || !containerRef.current) {
      return;
    }

    let cancelled = false;

    const mountWidget = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      if (widgetIdRef.current !== null) return;
      try {
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: trimmedSiteKey,
          theme: "light",
          language: "id",
          action,
          callback: (token: string) => {
            onTokenChangeRef.current(token);
          },
          "expired-callback": () => {
            onTokenChangeRef.current("");
          },
          "error-callback": () => {
            onTokenChangeRef.current("");
          },
        });
      } catch {
        onTokenChangeRef.current("");
      }
    };

    if (window.turnstile) {
      mountWidget();
    } else {
      let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement("script");
        script.id = TURNSTILE_SCRIPT_ID;
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.addEventListener("error", () => {
          onTokenChangeRef.current("");
        });
        document.head.appendChild(script);
      }
      script.addEventListener("load", mountWidget);
      return () => {
        cancelled = true;
        script?.removeEventListener("load", mountWidget);
        if (widgetIdRef.current && window.turnstile?.remove) {
          try {
            window.turnstile.remove(widgetIdRef.current);
          } catch {
            // Ignore cleanup errors
          }
          widgetIdRef.current = null;
        }
      };
    }

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile?.remove) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Ignore cleanup errors
        }
        widgetIdRef.current = null;
      }
    };
  }, [trimmedSiteKey, action]);

  return (
    <div
      data-testid="turnstile-slot"
      data-turnstile-configured={trimmedSiteKey ? "true" : "false"}
      className={trimmedSiteKey ? "flex justify-center pt-1" : "hidden"}
    >
      <div ref={containerRef} />
    </div>
  );
}
