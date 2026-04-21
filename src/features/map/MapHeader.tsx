import { useMapStore } from "./mapStore";
import type { MapMode, SceneDisplayVariant, ColorByAxis } from "./types";

const MODES: { key: MapMode; label: string }[] = [
  { key: "free", label: "Free" },
  { key: "time", label: "Time" },
  { key: "theme", label: "Theme" },
  { key: "pov", label: "POV" },
  { key: "place", label: "Place" },
];

const SCENE_DISPLAY_OPTIONS: { value: SceneDisplayVariant; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "compact", label: "Compact" },
  { value: "card", label: "Card" },
];

const COLOR_BY_OPTIONS: { value: ColorByAxis; label: string }[] = [
  { value: "none", label: "None" },
  { value: "status", label: "Status" },
];

export function MapHeader() {
  const mode = useMapStore((s) => s.mode);
  const setMode = useMapStore((s) => s.setMode);
  const show = useMapStore((s) => s.show);
  const setShow = useMapStore((s) => s.setShow);
  const minimapVisible = useMapStore((s) => s.minimapVisible);
  const setMinimapVisible = useMapStore((s) => s.setMinimapVisible);
  const sceneDisplayByMode = useMapStore((s) => s.sceneDisplayByMode);
  const setSceneDisplayForMode = useMapStore((s) => s.setSceneDisplayForMode);
  const colorBy = useMapStore((s) => s.colorBy);
  const setColorBy = useMapStore((s) => s.setColorBy);
  const corkboardFeel = useMapStore((s) => s.corkboardFeel);
  const setCorkboardFeel = useMapStore((s) => s.setCorkboardFeel);
  const setSearchVisible = useMapStore((s) => s.setSearchVisible);

  const currentDisplay = sceneDisplayByMode[mode];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
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

      <Divider />

      {/* Show checkboxes */}
      <ShowCheckbox
        label="Scenes"
        checked={show.scenes}
        onChange={(v) => setShow({ scenes: v })}
      />
      <ShowCheckbox
        label="Codex"
        checked={show.codex}
        onChange={(v) => setShow({ codex: v })}
      />
      <ShowCheckbox
        label="Edges"
        checked={show.derivedEdges}
        onChange={(v) => setShow({ derivedEdges: v })}
      />
      <ShowCheckbox
        label="User edges"
        checked={show.userEdges}
        onChange={(v) => setShow({ userEdges: v })}
      />
      <ShowCheckbox
        label="Frames"
        checked={show.frames}
        onChange={(v) => setShow({ frames: v })}
      />
      {/* Phase D用グレーアウトチェックボックス */}
      <DisabledCheckbox label="Notes" tooltip="Phase D で対応予定" />
      <DisabledCheckbox label="AI" tooltip="Phase D で対応予定" />

      <Divider />

      {/* Scene display dropdown */}
      <label
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}
      >
        <span style={{ color: "var(--muted-foreground)" }}>Display:</span>
        <select
          value={currentDisplay}
          onChange={(e) =>
            setSceneDisplayForMode(mode, e.target.value as SceneDisplayVariant)
          }
          style={{
            fontSize: 11,
            border: "1px solid var(--border)",
            borderRadius: 3,
            background: "var(--background)",
            color: "var(--foreground)",
            padding: "1px 2px",
            cursor: "pointer",
          }}
        >
          {SCENE_DISPLAY_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {/* Color by dropdown */}
      <label
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}
      >
        <span style={{ color: "var(--muted-foreground)" }}>Color:</span>
        <select
          value={colorBy}
          onChange={(e) => setColorBy(e.target.value as ColorByAxis)}
          style={{
            fontSize: 11,
            border: "1px solid var(--border)",
            borderRadius: 3,
            background: "var(--background)",
            color: "var(--foreground)",
            padding: "1px 2px",
            cursor: "pointer",
          }}
        >
          {COLOR_BY_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <Divider />

      {/* Corkboard feel */}
      <ShowCheckbox
        label="🪵 Cork"
        checked={corkboardFeel}
        onChange={setCorkboardFeel}
      />

      {/* Minimap */}
      <ShowCheckbox
        label="Minimap"
        checked={minimapVisible}
        onChange={setMinimapVisible}
      />

      {/* Search button */}
      <button
        onClick={() => setSearchVisible(true)}
        title="ノードを検索 (Ctrl+F)"
        style={{
          marginLeft: "auto",
          padding: "2px 8px",
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--foreground)",
          cursor: "pointer",
          fontSize: 11,
        }}
      >
        🔍
      </button>
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        width: 1,
        height: 16,
        background: "var(--border)",
        margin: "0 2px",
        flexShrink: 0,
      }}
    />
  );
}

function ShowCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        cursor: "pointer",
        fontSize: 11,
        userSelect: "none",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 12, height: 12, cursor: "pointer" }}
      />
      {label}
    </label>
  );
}

function DisabledCheckbox({
  label,
  tooltip,
}: {
  label: string;
  tooltip: string;
}) {
  return (
    <label
      title={tooltip}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        cursor: "not-allowed",
        fontSize: 11,
        color: "var(--muted-foreground)",
        opacity: 0.5,
        userSelect: "none",
      }}
    >
      <input
        type="checkbox"
        disabled
        checked={false}
        onChange={() => {}}
        style={{ width: 12, height: 12, cursor: "not-allowed" }}
      />
      {label}
    </label>
  );
}
