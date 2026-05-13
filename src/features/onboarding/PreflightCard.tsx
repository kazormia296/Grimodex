import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import i18next from "@/lib/i18n";
import { DURATIONS, EASINGS } from "@/lib/animation";
import { useWorkspaceStore } from "@/features/workspace/store";
import { expandPreset } from "@/features/ai-policy/preset";
import type { AiPolicyPreset } from "@/features/ai-policy/types";
import { LanguageStep } from "./preflight-steps/LanguageStep";
import { AiPolicyStep } from "./preflight-steps/AiPolicyStep";
import { AiProviderStep } from "./preflight-steps/AiProviderStep";

type Step = "language" | "aiPolicy" | "provider";

interface SkipDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

function SkipDialog({ onConfirm, onCancel }: SkipDialogProps) {
  const { t } = useTranslation();
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: DURATIONS.fast }}
    >
      <motion.div
        className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: DURATIONS.normal, ease: EASINGS.easeOut }}
      >
        <p className="mb-2 text-sm font-semibold text-foreground">
          {t("tour.skipConfirmTitle")}
        </p>
        <p className="mb-5 text-xs text-muted-foreground">
          {t("tour.skipConfirmDesc")}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-4 py-1.5 text-xs hover:bg-accent"
          >
            {t("tour.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-destructive px-4 py-1.5 text-xs text-destructive-foreground hover:bg-destructive/90"
          >
            {t("tour.skip")}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function PreflightCard() {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("language");
  const [selectedLang, setSelectedLang] = useState(
    useWorkspaceStore.getState().globalSettings?.uiLanguage ?? "ja",
  );
  const [selectedPolicy, setSelectedPolicy] = useState<AiPolicyPreset>("full");
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [starting, setStarting] = useState(false);

  const updateGlobalSettings = useWorkspaceStore((s) => s.updateGlobalSettings);
  const seedAndOpenSample = useWorkspaceStore((s) => s.seedAndOpenSample);
  const error = useWorkspaceStore((s) => s.error);

  // Provider step only shown when policy requires AI
  const steps: Step[] = useMemo(
    () =>
      selectedPolicy === "off"
        ? ["language", "aiPolicy"]
        : ["language", "aiPolicy", "provider"],
    [selectedPolicy],
  );
  const stepIndex = steps.indexOf(step);
  const totalSteps = steps.length;

  function handleLangChange(lang: string) {
    setSelectedLang(lang);
    void updateGlobalSettings({ uiLanguage: lang });
    void i18next.changeLanguage(lang);
  }

  function handleBack() {
    if (step === "aiPolicy") setStep("language");
    else if (step === "provider") setStep("aiPolicy");
  }

  async function startSample(overridePolicy?: string) {
    setStarting(true);
    const toggles = expandPreset(selectedPolicy);
    const policy =
      overridePolicy ?? JSON.stringify({ preset: selectedPolicy, toggles });
    await updateGlobalSettings({ defaultAiPolicy: policy });
    await seedAndOpenSample(selectedLang, policy);
    setStarting(false);
  }

  async function handleSetupLater() {
    // Downgrade policy to "off" so AI steps don't show in tour
    const offTogles = expandPreset("off");
    const offPolicy = JSON.stringify({ preset: "off", toggles: offTogles });
    await startSample(offPolicy);
  }

  async function handleSkipConfirm() {
    setShowSkipConfirm(false);
    await updateGlobalSettings({ hasSeenWelcome: true });
    await startSample();
  }

  const isLastStep = stepIndex === totalSteps - 1;
  const isAiPolicyStep = step === "aiPolicy";
  const isPolicyOff = selectedPolicy === "off";

  return (
    <>
      <AnimatePresence>
        {showSkipConfirm && (
          <SkipDialog
            onConfirm={() => void handleSkipConfirm()}
            onCancel={() => setShowSkipConfirm(false)}
          />
        )}
      </AnimatePresence>

      <div className="flex h-screen flex-col items-center justify-center bg-background text-foreground">
        <div className="relative mx-4 flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-border bg-card p-7 shadow-2xl">
          {/* Skip button */}
          <button
            type="button"
            onClick={() => setShowSkipConfirm(true)}
            className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("preflight.skip")}
          >
            <X size={16} />
          </button>

          {/* Progress dots */}
          <div className="flex justify-center gap-1.5">
            {steps.map((s, i) => (
              <span
                key={s}
                className={[
                  "h-1.5 rounded-full transition-all duration-200",
                  i === stepIndex
                    ? "w-5 bg-primary"
                    : i < stepIndex
                      ? "w-1.5 bg-primary/40"
                      : "w-1.5 bg-border",
                ].join(" ")}
              />
            ))}
          </div>

          {/* Step content */}
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: DURATIONS.normal, ease: EASINGS.easeOut }}
            >
              {step === "language" && (
                <LanguageStep
                  selected={selectedLang}
                  onChange={handleLangChange}
                />
              )}
              {step === "aiPolicy" && (
                <AiPolicyStep
                  selected={selectedPolicy}
                  onChange={setSelectedPolicy}
                />
              )}
              {step === "provider" && (
                <AiProviderStep onSetupLater={() => void handleSetupLater()} />
              )}
            </motion.div>
          </AnimatePresence>

          {/* Error */}
          {error && (
            <p className="text-center text-xs text-destructive">{error}</p>
          )}

          {/* Navigation */}
          <div className="flex flex-col gap-2">
            {step === "language" && (
              <button
                type="button"
                onClick={() => setStep("aiPolicy")}
                className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t("preflight.next")}
              </button>
            )}

            {isAiPolicyStep && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    isPolicyOff ? void startSample() : setStep("provider")
                  }
                  disabled={starting}
                  className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {starting
                    ? t("preflight.starting")
                    : isPolicyOff
                      ? t("preflight.startSample")
                      : t("preflight.nextProvider")}
                </button>
                <button
                  type="button"
                  onClick={handleBack}
                  className="w-full py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("preflight.back")}
                </button>
              </>
            )}

            {step === "provider" && isLastStep && (
              <>
                <button
                  type="button"
                  onClick={() => void startSample()}
                  disabled={starting}
                  className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {starting
                    ? t("preflight.starting")
                    : t("preflight.startSample")}
                </button>
                <button
                  type="button"
                  onClick={handleBack}
                  className="w-full py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("preflight.back")}
                </button>
              </>
            )}
          </div>

          {/* Step counter */}
          <p className="text-center text-xs text-muted-foreground/60">
            {t("preflight.stepOf", {
              current: stepIndex + 1,
              total: totalSteps,
            })}
          </p>
        </div>
      </div>
    </>
  );
}
