import { Copy, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ImeConsumerInfo } from "@/features/ime/api";
import { isLinuxImeHost } from "@/features/ime/linuxPlatform";
import { openExternalUrl } from "@/lib/safeUrl";

const LINUX_IME_CONSUMER_ID = "fcitx5-grimodex";
const LINUX_IME_PACKAGE_NAME = "fcitx5-grimodex";
const LINUX_IME_INSTALL_DOCS_URL =
  "https://github.com/kazormia296/hazkey#source-build-and-install";

interface LinuxImeInstallGuideProps {
  consumers: ImeConsumerInfo[];
}

export function LinuxImeInstallGuide({ consumers }: LinuxImeInstallGuideProps) {
  const { t } = useTranslation();
  const consumerPresent = consumers.some(
    (consumer) => consumer.consumerId === LINUX_IME_CONSUMER_ID,
  );

  if (!isLinuxImeHost() || consumerPresent) return null;

  const copyPackageName = async () => {
    try {
      await navigator.clipboard.writeText(LINUX_IME_PACKAGE_NAME);
      toast.success(t("settings.codex.imeLinuxCopyDone"));
    } catch {
      toast.error(t("settings.codex.imeLinuxCopyFailed"));
    }
  };

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
        <code className="rounded bg-muted px-1.5 py-1 text-[11px]">
          {LINUX_IME_PACKAGE_NAME}
        </code>
        <button
          type="button"
          className={buttonClass}
          onClick={() => void copyPackageName()}
        >
          <Copy className="h-3 w-3" />
          {t("settings.codex.imeLinuxCopyPackage")}
        </button>
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
