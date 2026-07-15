import { useCompactNavigationStore } from "./compactNavigationStore";
import "./phoneWorkspace.css";

interface Props {
  active: boolean;
  sceneTitle?: string;
  saveState?: string;
  onBack?: () => void;
}

const NAV_ITEMS = [
  { id: "editor", label: "Write" },
  { id: "scenes", label: "Scenes" },
  { id: "codex", label: "Codex" },
  { id: "ai", label: "AI" },
  { id: "more", label: "More" },
] as const;

export function PhoneWorkspaceChrome({
  active,
  sceneTitle = "Editor",
  saveState = "Saved",
  onBack,
}: Props) {
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
  return (
    <div
      data-adaptive-chrome="phone"
      data-active="true"
      className="phone-workspace-chrome"
    >
      <header className="phone-workspace-chrome__header">
        <button
          type="button"
          className="phone-workspace-chrome__back"
          aria-label="Back"
          onClick={() => {
            if (!navigation.goBack()) onBack?.();
          }}
        >
          ‹
        </button>
        <strong>{sceneTitle}</strong>
        <span aria-live="polite">{saveState}</span>
      </header>
      <nav className="phone-workspace-chrome__nav" aria-label="Workspace">
        {NAV_ITEMS.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-current={
              navigation.activeSurface === item.id ? "page" : undefined
            }
            onClick={() => navigation.openSurface(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
