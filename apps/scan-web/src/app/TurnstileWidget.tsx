import { useEffect, useRef, useState } from "react";
import { scanMessages } from "../i18n/scanMessages";
import type { ScanLocale } from "../i18n/scanLocale";

interface TurnstileRenderOptions {
  sitekey: string;
  language: ScanLocale;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SELECTOR = "script[data-grimodex-turnstile]";
const SCRIPT_SOURCE =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function TurnstileWidget({
  siteKey,
  resetKey,
  locale,
  onToken,
  onError,
}: {
  siteKey: string;
  resetKey: number;
  locale: ScanLocale;
  onToken: (token: string) => void;
  onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(
    () => typeof window !== "undefined" && Boolean(window.turnstile),
  );

  useEffect(() => {
    if (loaded) return;
    const existing = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
    const script = existing ?? document.createElement("script");
    const handleLoad = () => setLoaded(Boolean(window.turnstile));
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", onError);
    if (!existing) {
      script.async = true;
      script.defer = true;
      script.src = SCRIPT_SOURCE;
      script.dataset.grimodexTurnstile = "true";
      document.head.appendChild(script);
    }
    return () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", onError);
    };
  }, [loaded, onError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!loaded || !container || !window.turnstile) return;
    container.replaceChildren();
    const widgetId = window.turnstile.render(container, {
      sitekey: siteKey,
      language: locale,
      callback: onToken,
      "expired-callback": onError,
      "error-callback": onError,
    });
    return () => {
      window.turnstile?.remove(widgetId);
      container.replaceChildren();
    };
  }, [loaded, locale, onError, onToken, resetKey, siteKey]);

  return (
    <div
      ref={containerRef}
      className="scan-turnstile"
      aria-label={scanMessages(locale).turnstileLabel}
      data-testid="scan-turnstile"
    />
  );
}
