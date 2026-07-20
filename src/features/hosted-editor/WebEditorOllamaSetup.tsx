import { useTranslation } from "react-i18next";

export function WebEditorOllamaSetup() {
  const { t } = useTranslation();
  const editorOrigin =
    typeof window === "undefined"
      ? "Web Editor origin"
      : window.location.origin;

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-muted-foreground">
      <p>{t("hostedEditor.ollama.browserSetup")}</p>
      <code className="mt-2 block break-all rounded bg-muted px-2 py-1 text-foreground">
        {`OLLAMA_ORIGINS=${editorOrigin}`}
      </code>
      <p className="mt-2">{t("hostedEditor.ollama.localNetworkPermission")}</p>
      <div className="mt-2 flex flex-wrap gap-3">
        <a
          href="https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {t("hostedEditor.ollama.setupLink")}
        </a>
        <a
          href="https://developer.chrome.com/blog/local-network-access"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {t("hostedEditor.ollama.browserPermissionLink")}
        </a>
      </div>
    </div>
  );
}
