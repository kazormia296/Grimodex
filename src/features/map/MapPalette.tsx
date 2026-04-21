import { useCallback } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";

type PaletteMode = "default" | "frame" | "connect";

interface MapPaletteProps {
  paletteMode: PaletteMode;
  onPaletteModeChange: (mode: PaletteMode) => void;
}

export function MapPalette({
  paletteMode,
  onPaletteModeChange,
}: MapPaletteProps) {
  const createScene = useTreeStore((s) => s.createScene);
  const createCodexEntry = useCodexStore((s) => s.create);

  const handleAddScene = useCallback(async () => {
    await createScene();
  }, [createScene]);

  const handleAddCodex = useCallback(async () => {
    await createCodexEntry({
      name: "新しいエントリ",
      type: "character",
      summary: "",
    });
  }, [createCodexEntry]);

  const toggleMode = useCallback(
    (mode: PaletteMode) => {
      onPaletteModeChange(paletteMode === mode ? "default" : mode);
    },
    [paletteMode, onPaletteModeChange],
  );

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 6,
        zIndex: 10,
        background: "var(--sidebar-background)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "6px 12px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
        alignItems: "center",
      }}
    >
      <PaletteButton label="+ Scene" onClick={handleAddScene} />
      <PaletteButton label="+ Codex" onClick={handleAddCodex} />

      <div
        style={{
          width: 1,
          height: 20,
          background: "var(--border)",
          margin: "0 2px",
        }}
      />

      <PaletteButton
        label="+ Frame"
        active={paletteMode === "frame"}
        onClick={() => toggleMode("frame")}
        title="フレームを描画 (F)"
      />
      <PaletteButton
        label="⌥ Connect"
        active={paletteMode === "connect"}
        onClick={() => toggleMode("connect")}
        title="エッジを接続 (Alt)"
      />

      <div
        style={{
          width: 1,
          height: 20,
          background: "var(--border)",
          margin: "0 2px",
        }}
      />

      <PaletteButton label="+ Note" disabled title="Phase D で対応予定" />
      <PaletteButton label="+ AI" disabled title="Phase D で対応予定" />

      {/* Mode indicator */}
      {paletteMode !== "default" && (
        <div
          style={{
            position: "absolute",
            top: -28,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--accent)",
            color: "var(--accent-foreground)",
            borderRadius: 4,
            padding: "2px 10px",
            fontSize: 11,
            whiteSpace: "nowrap",
          }}
        >
          {paletteMode === "frame"
            ? "キャンバスをドラッグしてフレームを作成 (Esc でキャンセル)"
            : "ノードをクリックしてエッジを開始 (Esc でキャンセル)"}
        </div>
      )}
    </div>
  );
}

function PaletteButton({
  label,
  onClick,
  disabled,
  active,
  title,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: "4px 10px",
        fontSize: 12,
        borderRadius: 4,
        border: "1px solid",
        borderColor: active ? "#534AB7" : "var(--border)",
        background: active
          ? "#534AB7"
          : disabled
            ? "transparent"
            : "var(--secondary)",
        color: active
          ? "#fff"
          : disabled
            ? "var(--muted-foreground)"
            : "var(--secondary-foreground)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}
