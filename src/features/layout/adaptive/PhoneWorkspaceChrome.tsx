import {
  Bot,
  BookOpenText,
  Library,
  MoreHorizontal,
  PenLine,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCompactNavigationStore } from "./compactNavigationStore";
import "./phoneWorkspace.css";

interface Props {
  active: boolean;
  onBack?: () => void;
}

const NAV_ITEMS = [
  {
    id: "editor",
    labelKey: "mobileWorkspace.navigation.editor",
    Icon: PenLine,
  },
  {
    id: "scenes",
    labelKey: "mobileWorkspace.navigation.scenes",
    Icon: BookOpenText,
  },
  {
    id: "codex",
    labelKey: "mobileWorkspace.navigation.codex",
    Icon: Library,
  },
  { id: "ai", labelKey: "mobileWorkspace.navigation.ai", Icon: Bot },
  {
    id: "more",
    labelKey: "mobileWorkspace.navigation.more",
    Icon: MoreHorizontal,
  },
] as const;

export function PhoneWorkspaceChrome({ active, onBack }: Props) {
  const { t } = useTranslation();
  const navigation = useCompactNavigationStore();
  if (!active) {
    return (
      <div
        data-adaptive-chrome="phone"
        data-active="false"
        aria-hidden="true"
        inert
      />
    );
  }
  const activeItem = NAV_ITEMS.find(
    (item) => item.id === navigation.activeSurface,
  );
  const heading =
    navigation.activeSurface === "search"
      ? t("mobileWorkspace.surfaces.search.title")
      : activeItem
        ? t(activeItem.labelKey)
        : navigation.activeSurface;
  const canGoBack = navigation.backStack.length > 0 || onBack !== undefined;
  const showHeader = navigation.activeSurface !== "editor";

  return (
    <div
      data-adaptive-chrome="phone"
      data-active="true"
      className="phone-workspace-chrome"
    >
      {showHeader && (
        <header className="phone-workspace-chrome__header">
          {canGoBack ? (
            <button
              type="button"
              className="phone-workspace-chrome__back"
              aria-label={t("mobileWorkspace.header.back")}
              onClick={() => {
                if (!navigation.goBack()) onBack?.();
              }}
            >
              ‹
            </button>
          ) : (
            <span aria-hidden="true" className="block min-h-11 min-w-11" />
          )}
          <h1 className="m-0 min-w-0 truncate text-base font-semibold">
            {heading}
          </h1>
        </header>
      )}
      <nav
        className="phone-workspace-chrome__nav"
        aria-label={t("mobileWorkspace.navigation.label")}
      >
        {NAV_ITEMS.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-current={
              navigation.activeSurface === item.id ? "page" : undefined
            }
            onClick={() => navigation.openSurface(item.id)}
          >
            <item.Icon className="h-5 w-5" aria-hidden />
            {t(item.labelKey)}
          </button>
        ))}
      </nav>
    </div>
  );
}
