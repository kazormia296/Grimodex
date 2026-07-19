/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SCAN_API_BASE_URL?: string;
  readonly VITE_SCAN_AUTH_REQUIRED?: string;
  readonly VITE_SCAN_TURNSTILE_SITE_KEY?: string;
  readonly VITE_SCAN_TURNSTILE_REQUIRED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
