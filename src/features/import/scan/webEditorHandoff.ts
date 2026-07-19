import {
  parseEditorHandoffEnvelope,
  type EditorHandoffEnvelopeV1,
  type EditorUiLanguage,
} from "@grimodex/scan-contract";

const EDITOR_HANDOFF_FRAGMENT_KEY = "scan-import";
const EDITOR_UI_LANGUAGE_FRAGMENT_KEY = "ui-language";

export type ConsumedEditorSeedHandoff = EditorHandoffEnvelopeV1 & {
  uiLanguage?: EditorUiLanguage;
};

export interface ConsumeEditorSeedHandoffOptions {
  href: string;
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  replaceHistory: (href: string) => void;
}

/**
 * Consumes a Scan seed token during the hosted Editor bootstrap.
 *
 * The fragment is removed before any network work so the one-time token does
 * not remain in browser history if the consume request fails.
 */
export async function consumeEditorSeedHandoff({
  href,
  apiBaseUrl,
  fetchImpl,
  replaceHistory,
}: ConsumeEditorSeedHandoffOptions): Promise<ConsumedEditorSeedHandoff | null> {
  const editorUrl = new URL(href);
  const fragment = new URLSearchParams(editorUrl.hash.slice(1));
  const editorToken = fragment.get(EDITOR_HANDOFF_FRAGMENT_KEY);
  if (editorToken === null) return null;
  const uiLanguageValue = fragment.get(EDITOR_UI_LANGUAGE_FRAGMENT_KEY);
  const uiLanguage: EditorUiLanguage | undefined =
    uiLanguageValue === "ja" || uiLanguageValue === "en"
      ? uiLanguageValue
      : undefined;

  editorUrl.hash = "";
  replaceHistory(editorUrl.toString());

  if (editorToken.length === 0) {
    throw new Error("Editor handoff token must not be empty");
  }

  const normalizedApiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(
    `${normalizedApiBaseUrl}/api/v1/editor-seeds`,
    {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${editorToken}`,
      },
      referrerPolicy: "no-referrer",
    },
  );
  if (!response.ok) {
    throw new Error(`Editor seed request failed (${response.status})`);
  }
  const parsed = parseEditorHandoffEnvelope(await response.json());
  if (!parsed.ok) {
    throw new Error("Editor handoff response is invalid");
  }
  return uiLanguage ? { ...parsed.value, uiLanguage } : parsed.value;
}
