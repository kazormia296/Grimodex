import { useState, useEffect } from "react";
import { GitBranch, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

const GITHUB_URL = "https://github.com/kazormia296/Grimodex";

export function AppInfoHeader() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <div className="flex-shrink-0 border-b border-border px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Grimodex</h2>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {version != null && <span>v{version}</span>}
            <span className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              Elastic-2.0
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("show-welcome-tour"))
            }
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            {t("settings.about.showWelcomeTour")}
          </button>
          <a
            href={GITHUB_URL}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(GITHUB_URL);
            }}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            <GitBranch className="h-3.5 w-3.5" />
            {t("settings.about.github")}
            <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
        </div>
      </div>
    </div>
  );
}
