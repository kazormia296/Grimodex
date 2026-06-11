import { useCallback, useEffect, useRef, useState } from "react";
import type { AiGatePresentation } from "@/features/ai-policy/evaluateAiCapability";

type PaletteMode = "default" | "frame" | "connect";
type PickerEntityType = "scene" | "note" | "codex" | "snippet";

interface MapPaletteProps {
  paletteMode: PaletteMode;
  onPaletteModeChange: (mode: PaletteMode) => void;
  onAddSticky: () => void;
  onOpenPicker: (type: PickerEntityType) => void;
  onOpenAiBranch: () => void;
  aiBranchPresentation: AiGatePresentation;
  aiBranchTooltip: string | null;
}

const PICKER_ITEMS: { type: PickerEntityType; label: string }[] = [
  { type: "scene", label: "シーンを追加…" },
  { type: "note", label: "ノートを追加…" },
  { type: "codex", label: "Codexを追加…" },
  { type: "snippet", label: "スニペットを追加…" },
];

export function MapPalette({
  paletteMode,
  onPaletteModeChange,
  onAddSticky,
  onOpenPicker,
  onOpenAiBranch,
  aiBranchPresentation,
  aiBranchTooltip,
}: MapPaletteProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  const toggleMode = useCallback(
    (mode: PaletteMode) => {
      onPaletteModeChange(paletteMode === mode ? "default" : mode);
    },
    [paletteMode, onPaletteModeChange],
  );

  useEffect(() => {
    if (!addMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        addMenuRef.current &&
        !addMenuRef.current.contains(e.target as Node)
      ) {
        setAddMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [addMenuOpen]);

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
      <PaletteButton
        label="+ Sticky"
        onClick={onAddSticky}
        title="付箋を追加 (S)"
      />

      {/* policy で chat OFF のときはボタンごと隠す（provider/model 未設定は
          disabled 表示で設定導線を残す）。kouetsu views と同じ gate 規約。 */}
      {aiBranchPresentation !== "hidden" && (
        <PaletteButton
          label="✦ AI Branch"
          onClick={onOpenAiBranch}
          disabled={aiBranchPresentation === "disabled"}
          title={aiBranchTooltip ?? "AI Branchを生成"}
        />
      )}

      {/* [▾ Add…] dropdown */}
      <div ref={addMenuRef} style={{ position: "relative" }}>
        <PaletteButton
          label="▾ Add…"
          active={addMenuOpen}
          onClick={() => setAddMenuOpen((v) => !v)}
          title="既存エンティティをMapに追加"
        />
        {addMenuOpen && (
          <div
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 0,
              minWidth: 160,
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              padding: "4px 0",
              zIndex: 20,
            }}
          >
            {PICKER_ITEMS.map((item) => (
              <button
                key={item.type}
                type="button"
                onClick={() => {
                  setAddMenuOpen(false);
                  onOpenPicker(item.type);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "6px 14px",
                  textAlign: "left",
                  fontSize: 12,
                  background: "transparent",
                  border: "none",
                  color: "var(--foreground)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--accent)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <PaletteButton
        label="+ Frame"
        active={paletteMode === "frame"}
        onClick={() => toggleMode("frame")}
        title="フレームを描画 (F)"
      />

      <div
        style={{
          width: 1,
          height: 20,
          background: "var(--border)",
          margin: "0 2px",
        }}
      />

      <PaletteButton
        label="⌥ Connect"
        active={paletteMode === "connect"}
        onClick={() => toggleMode("connect")}
        title="エッジを接続 (Alt)"
      />

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
