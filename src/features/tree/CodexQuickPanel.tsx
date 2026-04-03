import { CodexQuickSection } from "./CodexQuickSection";

/**
 * CodexQuickPanel — standalone dockview panel for Codex Quick.
 * Displays auto-detected and pinned Codex entries for the active scene.
 */
export function CodexQuickPanel() {
  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center border-b border-border px-2 py-1.5">
        <span className="text-xs font-semibold text-foreground">
          Codex Quick
        </span>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <CodexQuickSection />
      </div>
    </div>
  );
}
