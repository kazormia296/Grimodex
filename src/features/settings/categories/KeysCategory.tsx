import { useState, useEffect } from "react";
import { useSettingsStore } from "../settingsStore";
import {
  COMMANDS,
  DEFAULT_KEYBINDINGS,
  keyEventToString,
  detectConflicts,
} from "../keybindings";

export function KeysCategory() {
  const store = useSettingsStore();
  const [search, setSearch] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({});

  // Parse stored bindings (overlay on defaults)
  const storedJson = store.get("keys.bindings", "{}");
  const storedOverrides: Record<string, string> = (() => {
    try {
      return JSON.parse(storedJson);
    } catch {
      return {};
    }
  })();

  const bindings: Record<string, string> = {
    ...DEFAULT_KEYBINDINGS,
    ...storedOverrides,
  };

  function saveOverride(id: string, binding: string) {
    const next = { ...storedOverrides, [id]: binding };
    store.set("keys.bindings", JSON.stringify(next));
  }

  function resetAll() {
    store.set("keys.bindings", "{}");
  }

  function resetOne(id: string) {
    const next = { ...storedOverrides };
    delete next[id];
    store.set("keys.bindings", JSON.stringify(next));
  }

  // Capture key
  useEffect(() => {
    if (!capturing) return;
    const capId: string = capturing;

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      // Ignore bare modifiers
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      // Escape cancels
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }

      const combo = keyEventToString(e);
      saveOverride(capId, combo);

      // Check conflicts
      const newBindings: Record<string, string> = {
        ...bindings,
        [capId]: combo,
      };
      const found = detectConflicts(newBindings, capId);
      setConflicts((prev) => ({ ...prev, [capId]: found.length > 0 }));

      setCapturing(null);
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, bindings, storedOverrides]);

  const filtered = COMMANDS.filter(
    (c) =>
      !search ||
      c.label.toLowerCase().includes(search.toLowerCase()) ||
      bindings[c.id]?.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="キーバインドを検索…"
          className="w-56 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none"
        />
        <button
          type="button"
          onClick={resetAll}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          すべてデフォルトにリセット
        </button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="pb-1.5 text-left font-medium">コマンド</th>
            <th className="pb-1.5 text-right font-medium">キーバインド</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((cmd) => {
            const isCapturing = capturing === cmd.id;
            const isModified = storedOverrides[cmd.id] !== undefined;
            const hasConflict = conflicts[cmd.id];

            return (
              <tr
                key={cmd.id}
                className="group border-b border-border/50 last:border-0"
              >
                <td className="py-1.5 pr-4 text-foreground">{cmd.label}</td>
                <td className="py-1.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {hasConflict && (
                      <span className="text-xs text-destructive">競合</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setCapturing(isCapturing ? null : cmd.id)}
                      className={`rounded px-2 py-0.5 font-mono text-xs tabular-nums transition-colors ${
                        isCapturing
                          ? "bg-primary text-primary-foreground"
                          : hasConflict
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      {isCapturing
                        ? "キーを押してください…"
                        : (bindings[cmd.id] ?? "未設定")}
                    </button>
                    {isModified && (
                      <button
                        type="button"
                        onClick={() => resetOne(cmd.id)}
                        className="invisible text-xs text-muted-foreground underline hover:text-foreground group-hover:visible"
                      >
                        リセット
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
