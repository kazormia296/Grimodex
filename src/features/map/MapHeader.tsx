import { useMapStore } from "./mapStore";
import type { MapMode } from "./types";

const MODES: { key: MapMode; label: string }[] = [
  { key: "free", label: "Free" },
  { key: "time", label: "Time" },
  { key: "theme", label: "Theme" },
  { key: "pov", label: "POV" },
  { key: "place", label: "Place" },
];

export function MapHeader() {
  const mode = useMapStore((s) => s.mode);
  const setMode = useMapStore((s) => s.setMode);
  const show = useMapStore((s) => s.show);
  const setShow = useMapStore((s) => s.setShow);
  const minimapVisible = useMapStore((s) => s.minimapVisible);
  const setMinimapVisible = useMapStore((s) => s.setMinimapVisible);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        borderBottom: "1px solid var(--border)",
        background: "var(--sidebar-background)",
        color: "var(--foreground)",
        flexShrink: 0,
        flexWrap: "wrap",
        fontSize: 12,
      }}
    >
      {/* Panel title */}
      <span style={{ fontWeight: 600, marginRight: 4, fontSize: 13 }}>Map</span>

      {/* Mode buttons */}
      <div style={{ display: "flex", gap: 2 }}>
        {MODES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            title={
              key !== "free"
                ? `${label} モード（Phase C以降実装予定）`
                : "Free モード"
            }
            disabled={key !== "free"}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid",
              borderColor: mode === key ? "#534AB7" : "var(--border)",
              background: mode === key ? "#534AB7" : "transparent",
              color:
                key === "free"
                  ? mode === key
                    ? "#fff"
                    : "var(--foreground)"
                  : "var(--muted-foreground)",
              cursor: key === "free" ? "pointer" : "not-allowed",
              fontSize: 11,
              fontWeight: mode === key ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        style={{
          width: 1,
          height: 16,
          background: "var(--border)",
          margin: "0 4px",
        }}
      />

      {/* Show checkboxes */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={show.scenes}
          onChange={(e) => setShow({ scenes: e.target.checked })}
        />
        Scenes
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={show.codex}
          onChange={(e) => setShow({ codex: e.target.checked })}
        />
        Codex
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={show.derivedEdges}
          onChange={(e) => setShow({ derivedEdges: e.target.checked })}
        />
        Edges
      </label>

      <div
        style={{
          width: 1,
          height: 16,
          background: "var(--border)",
          margin: "0 4px",
        }}
      />

      {/* Minimap toggle */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={minimapVisible}
          onChange={(e) => setMinimapVisible(e.target.checked)}
        />
        Minimap
      </label>
    </div>
  );
}
