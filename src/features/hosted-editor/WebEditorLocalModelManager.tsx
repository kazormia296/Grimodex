import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/features/chat/ModelPicker";
import type { AiModel } from "@/features/chat/types";
import { isBrowserWebGpuAvailable } from "@/lib/browser-webllm";

interface WebEditorLocalModelManagerProps {
  models: AiModel[];
  value: string;
  isLoading: boolean;
  error: string | null;
  onChange: (model: string) => void;
  onRefresh: () => void;
}

export function WebEditorLocalModelManager({
  models,
  value,
  isLoading,
  error,
  onChange,
  onRefresh,
}: WebEditorLocalModelManagerProps) {
  const { t } = useTranslation();
  const supported = isBrowserWebGpuAvailable();
  return (
    <div className="space-y-3 rounded-md border border-primary/25 bg-primary/5 p-3">
      <div>
        <p className="text-sm font-medium">
          {t("hostedEditor.ai.webGpuTitle")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("hostedEditor.ai.webGpuDescription")}
        </p>
      </div>
      <p
        className={`text-xs ${supported ? "text-green-600" : "text-destructive"}`}
      >
        {supported
          ? t("hostedEditor.ai.webGpuAvailable")
          : t("hostedEditor.ai.webGpuUnavailable")}
      </p>
      <div className="flex flex-wrap gap-2">
        <ModelPicker
          models={models}
          value={value}
          onChange={onChange}
          isLoading={isLoading}
        />
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="rounded-md border border-border px-2 py-1 text-sm disabled:opacity-50"
        >
          {t("hostedEditor.ai.refreshLocalModels")}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("hostedEditor.ai.webGpuDownloadNotice")}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
