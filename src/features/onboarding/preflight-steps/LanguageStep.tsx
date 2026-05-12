import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { DURATIONS, EASINGS } from "@/lib/animation";

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語", flag: "🇯🇵" },
  { value: "en", label: "English", flag: "🇺🇸" },
];

interface LanguageStepProps {
  selected: string;
  onChange: (lang: string) => void;
}

export function LanguageStep({ selected, onChange }: LanguageStepProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-center text-base font-semibold text-foreground">
        {t("preflight.step1Title")}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {LANGUAGE_OPTIONS.map((opt) => (
          <motion.button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            whileTap={{ scale: 0.98 }}
            transition={{
              duration: DURATIONS.fast,
              ease: EASINGS.easeOut,
            }}
            className={[
              "flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors",
              selected === opt.value
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-accent",
            ].join(" ")}
          >
            <span className="text-xl">{opt.flag}</span>
            <span className="font-medium">{opt.label}</span>
            {selected === opt.value && (
              <span className="ml-auto h-2 w-2 rounded-full bg-primary" />
            )}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
