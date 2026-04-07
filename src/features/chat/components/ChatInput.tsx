import { useRef, useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { Send, Square, Wrench, ChevronDown } from "lucide-react";
import { useAiSettingsStore } from "../store";
import { useChatStore } from "../chatStore";
import { getModelCapabilities } from "../agent/modelLimits";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
}

export function ChatInput({
  value,
  onChange,
  onSend,
  disabled,
}: ChatInputProps) {
  const isStreaming = disabled ?? false;
  const canSend = value.trim().length > 0 && !isStreaming;

  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const agentMode = useChatStore((s) => s.agentMode);
  const setAgentMode = useChatStore((s) => s.setAgentMode);

  const aiSettings = useAiSettingsStore((s) => s.settings);
  const saveSettings = useAiSettingsStore((s) => s.saveSettings);
  const models = useAiSettingsStore((s) => s.models);
  const loadModels = useAiSettingsStore((s) => s.loadModels);

  const currentModel = aiSettings?.model ?? "";
  const caps = getModelCapabilities(currentModel);

  const [optionsOpen, setOptionsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  // close popovers on outside click
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node))
        setOptionsOpen(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node))
        setModelOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
    if (e.key === "Escape" && isStreaming) {
      stopGeneration();
    }
  };

  const modelLabel = (() => {
    if (!currentModel) return "モデル未設定";
    const parts = currentModel.split("/");
    return parts[parts.length - 1];
  })();

  const handleOpenModelMenu = () => {
    if (!modelOpen) loadModels();
    setModelOpen((v) => !v);
  };

  const handleSelectModel = async (modelId: string) => {
    if (!aiSettings) return;
    await saveSettings({ ...aiSettings, model: modelId });
    setModelOpen(false);
  };

  const handleToggleThinking = async () => {
    if (!aiSettings) return;
    await saveSettings({
      ...aiSettings,
      thinkingEnabled: !aiSettings.thinkingEnabled,
    });
  };

  const canUseTools = caps.supportsTools;
  const canThink = caps.supportsThinking || caps.supportsAdaptiveThinking;

  return (
    <div className="border-t border-border p-3">
      {/* テキスト入力エリア */}
      <div className="flex gap-2">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? "生成中…" : "メッセージを入力…"}
          rows={1}
          disabled={isStreaming}
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          role="textbox"
        />

        {/* Send / Stop ボタン */}
        {isStreaming ? (
          <button
            type="button"
            onClick={stopGeneration}
            aria-label="生成中断"
            title="生成中断 (Esc)"
            className="inline-flex items-center justify-center rounded-md bg-destructive px-3 py-2 text-destructive-foreground hover:bg-destructive/90"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            aria-label="送信"
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 下段: 🛠️ オプション + モデル選択 */}
      <div className="mt-1.5 flex items-center justify-between">
        {/* 🛠️ オプションポップオーバー */}
        <div className="relative" ref={optionsRef}>
          <button
            type="button"
            onClick={() => setOptionsOpen((v) => !v)}
            disabled={!canUseTools && !canThink}
            title="AIオプション"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Wrench className="h-3 w-3" />
          </button>

          {optionsOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md">
              {/* Agent mode トグル */}
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent">
                <input
                  type="checkbox"
                  checked={agentMode}
                  onChange={(e) => setAgentMode(e.target.checked)}
                  disabled={!canUseTools}
                  className="h-3 w-3"
                />
                <span className={!canUseTools ? "opacity-40" : ""}>
                  🔧 エージェントモード
                </span>
              </label>

              {/* Thinking トグル */}
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent">
                <input
                  type="checkbox"
                  checked={aiSettings?.thinkingEnabled ?? true}
                  onChange={handleToggleThinking}
                  disabled={!canThink}
                  className="h-3 w-3"
                />
                <span className={!canThink ? "opacity-40" : ""}>
                  💡 Thinking
                </span>
              </label>

              {/* RAG トグル (未実装) */}
              <label className="flex cursor-not-allowed items-center gap-2 px-3 py-1.5 text-xs opacity-40">
                <input type="checkbox" disabled className="h-3 w-3" />
                🌐 RAG (未実装)
              </label>
            </div>
          )}
        </div>

        {/* モデル選択 */}
        <div className="relative" ref={modelRef}>
          <button
            type="button"
            onClick={handleOpenModelMenu}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title="モデルを変更"
          >
            <span className="max-w-[120px] truncate">{modelLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>

          {modelOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-1 max-h-48 min-w-[200px] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
              {models.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  モデルを読み込み中…
                </p>
              ) : (
                models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleSelectModel(m.id)}
                    className={[
                      "w-full px-3 py-1.5 text-left text-xs hover:bg-accent",
                      m.id === currentModel
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    ].join(" ")}
                  >
                    {m.name || m.id}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
