import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { MessageSquare, PenLine, ScanSearch, WifiOff } from "lucide-react";
import { DURATIONS, EASINGS } from "@/lib/animation";
import type { AiPolicyPreset } from "@/features/ai-policy/types";

interface PresetOption {
  value: AiPolicyPreset;
  i18nKey: string;
  Icon: React.ElementType;
}

const PRESET_OPTIONS: PresetOption[] = [
  { value: "full", i18nKey: "full", Icon: MessageSquare },
  { value: "assist-off", i18nKey: "assistOff", Icon: ScanSearch },
  { value: "review-only", i18nKey: "reviewOnly", Icon: PenLine },
  { value: "off", i18nKey: "off", Icon: WifiOff },
];

interface AiPolicyStepProps {
  selected: AiPolicyPreset;
  onChange: (preset: AiPolicyPreset) => void;
}

export function AiPolicyStep({ selected, onChange }: AiPolicyStepProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-center text-base font-semibold text-foreground">
        {t("preflight.step2Title")}
      </p>
      <p className="text-center text-xs text-muted-foreground">
        {t("preflight.step2Subtitle")}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {PRESET_OPTIONS.map(({ value, i18nKey, Icon }) => (
          <motion.button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            whileTap={{ scale: 0.98 }}
            transition={{
              duration: DURATIONS.fast,
              ease: EASINGS.easeOut,
            }}
            className={[
              "flex items-start gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors",
              selected === value
                ? "border-primary bg-primary/10"
                : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-accent",
            ].join(" ")}
          >
            <Icon
              size={16}
              className={
                selected === value
                  ? "mt-0.5 shrink-0 text-primary"
                  : "mt-0.5 shrink-0 text-muted-foreground"
              }
            />
            <div className="flex flex-col gap-0.5">
              <span
                className={
                  selected === value
                    ? "font-medium text-foreground"
                    : "font-medium"
                }
              >
                {t(`aiPolicy.${i18nKey}.label`)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(`aiPolicy.${i18nKey}.desc`)}
              </span>
            </div>
            {selected === value && (
              <span className="ml-auto mt-0.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
            )}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
