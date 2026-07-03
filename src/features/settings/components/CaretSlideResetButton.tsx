import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useSettingNumber } from "../useSettingControl";
import {
  CARET_SLIDE_DURATION_DEFAULT,
  CARET_SLIDE_SNAPPINESS_DEFAULT,
} from "@/features/editor/caretSlideStyle";

/**
 * キャレットスライド設定 (duration / snappiness) を既定値へ戻すボタン。
 * 設定パネル本体（プレビュー行）に置く。両方とも既定値のときは無効。
 */
export function CaretSlideResetButton() {
  const { t } = useTranslation();
  const { value: duration, setValue: setDuration } = useSettingNumber(
    "editor.caretSlideDuration",
    CARET_SLIDE_DURATION_DEFAULT,
  );
  const { value: snappiness, setValue: setSnappiness } = useSettingNumber(
    "editor.caretSlideSnappiness",
    CARET_SLIDE_SNAPPINESS_DEFAULT,
  );
  const isDefault =
    duration === CARET_SLIDE_DURATION_DEFAULT &&
    snappiness === CARET_SLIDE_SNAPPINESS_DEFAULT;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={isDefault}
      onClick={() => {
        setDuration(CARET_SLIDE_DURATION_DEFAULT);
        setSnappiness(CARET_SLIDE_SNAPPINESS_DEFAULT);
      }}
    >
      {t("settings.editor.caretMotionReset")}
    </Button>
  );
}
