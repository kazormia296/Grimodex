import { useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ImeConsumerInfo } from "@/features/ime/api";
import { isLinuxImeHost } from "@/features/ime/linuxPlatform";
import {
  canInstallMozkeyFromApp,
  downloadAndInstallMozkey,
} from "@/features/ime/mozkeyInstaller";
import { openExternalUrl } from "@/lib/safeUrl";

const LINUX_IME_INSTALL_DOCS_URL = "https://github.com/kazormia296/mozkey-ibg";

interface LinuxImeInstallGuideProps {
  consumers: ImeConsumerInfo[];
}

export function LinuxImeInstallGuide({ consumers }: LinuxImeInstallGuideProps) {
  const { t } = useTranslation();
  const [installing, setInstalling] = useState(false);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const consumerPresent = consumers.length > 0;
  const canInstall = canInstallMozkeyFromApp();

  if (!canInstall && (consumerPresent || !isLinuxImeHost())) return null;

  const buttonClass =
    "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent";

  const startInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    setInstalledVersion(null);
    try {
      const result = await downloadAndInstallMozkey();
      setInstalledVersion(result.version);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      role="status"
      className="mt-2 rounded-md border border-border bg-muted/20 p-3 text-xs"
    >
      <p className="font-medium">
        {canInstall
          ? t("settings.codex.imeMozkeyInstallTitle")
          : t("settings.codex.imeLinuxInstallTitle")}
      </p>
      <p className="mt-1 text-muted-foreground">
        {canInstall
          ? t("settings.codex.imeMozkeyInstallDescription")
          : t("settings.codex.imeLinuxInstallDescription")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canInstall && (
          <button
            type="button"
            className={buttonClass}
            disabled={installing}
            aria-busy={installing}
            onClick={() => void startInstall()}
          >
            <Download className="h-3 w-3" />
            {installing
              ? t("settings.codex.imeMozkeyInstalling")
              : t("settings.codex.imeMozkeyInstallAction")}
          </button>
        )}
        <button
          type="button"
          className={buttonClass}
          onClick={() => openExternalUrl(LINUX_IME_INSTALL_DOCS_URL)}
        >
          <ExternalLink className="h-3 w-3" />
          {t("settings.codex.imeLinuxInstallDocs")}
        </button>
      </div>
      {installedVersion && (
        <p className="mt-2 text-emerald-600 dark:text-emerald-400">
          {t("settings.codex.imeMozkeyInstallStarted", {
            version: installedVersion,
          })}
        </p>
      )}
      {installError && (
        <p role="alert" className="mt-2 text-destructive">
          {t("settings.codex.imeMozkeyInstallFailed", {
            error: installError,
          })}
        </p>
      )}
    </div>
  );
}
