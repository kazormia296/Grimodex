import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ImeConsumerInfo } from "@/features/ime/api";
import { isLinuxImeHost } from "@/features/ime/linuxPlatform";
import { openExternalUrl } from "@/lib/safeUrl";

const LINUX_IME_INSTALL_DOCS_URL = "https://github.com/kazormia296/mozkey-ibg";

interface LinuxImeInstallGuideProps {
  consumers: ImeConsumerInfo[];
}

export function LinuxImeInstallGuide({ consumers }: LinuxImeInstallGuideProps) {
  const { t } = useTranslation();
  const consumerPresent = consumers.length > 0;

  if (!isLinuxImeHost() || consumerPresent) return null;

  const buttonClass =
    "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent";

  return (
    <div
      role="status"
      className="mt-2 rounded-md border border-border bg-muted/20 p-3 text-xs"
    >
      <p className="font-medium">{t("settings.codex.imeLinuxInstallTitle")}</p>
      <p className="mt-1 text-muted-foreground">
        {t("settings.codex.imeLinuxInstallDescription")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          onClick={() => openExternalUrl(LINUX_IME_INSTALL_DOCS_URL)}
        >
          <ExternalLink className="h-3 w-3" />
          {t("settings.codex.imeLinuxInstallDocs")}
        </button>
      </div>
    </div>
  );
}
