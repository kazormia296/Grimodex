import { useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DURATIONS,
  EASINGS,
  VARIANTS,
  useReducedMotion,
} from "@/lib/animation";
import type {
  AskUserContent,
  AskUserQuestionSpec,
  AskUserSpec,
  UserQuestionAnswer,
} from "../agent/agentTypes";

interface UserQuestionCardProps {
  spec: AskUserSpec;
  onSubmit: (answer: AskUserContent) => void;
  onSkip: () => void;
}

/** 1 質問あたりの編集中ローカル状態。 */
interface QAState {
  /** single/multi で選択中の option（single は length<=1）。 */
  selected: string[];
  /** 「その他（自由記述）」を選択中か（allowFreeText 時のみ）。 */
  otherSelected: boolean;
  /** text 回答、または「その他」の自由記述。 */
  text: string;
}

function emptyState(): QAState {
  return { selected: [], otherSelected: false, text: "" };
}

function isAnswered(q: AskUserQuestionSpec, st: QAState): boolean {
  if (q.kind === "text") return st.text.trim().length > 0;
  if (st.otherSelected) {
    return st.text.trim().length > 0 || st.selected.length > 0;
  }
  return st.selected.length > 0;
}

function buildAnswer(
  q: AskUserQuestionSpec,
  st: QAState,
  index: number,
): UserQuestionAnswer {
  const base = { questionIndex: index, header: q.header, question: q.question };
  if (q.kind === "text") {
    return { ...base, text: st.text.trim() };
  }
  const freeText =
    st.otherSelected && st.text.trim() ? st.text.trim() : undefined;
  return {
    ...base,
    selected: [...st.selected],
    ...(freeText ? { text: freeText } : {}),
  };
}

export function UserQuestionCard({
  spec,
  onSubmit,
  onSkip,
}: UserQuestionCardProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const questions = spec.questions;
  const isWizard = questions.length > 1;

  const [states, setStates] = useState<QAState[]>(() =>
    questions.map(() => emptyState()),
  );
  const [step, setStep] = useState(0);

  const current = questions[step];
  const currentState = states[step];
  const currentAnswered = isAnswered(current, currentState);
  const isLast = step === questions.length - 1;

  const update = (idx: number, patch: Partial<QAState>) => {
    setStates((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  };

  const toggleOption = (q: AskUserQuestionSpec, idx: number, opt: string) => {
    const s = states[idx];
    if (q.kind === "single") {
      update(idx, { selected: [opt], otherSelected: false });
    } else {
      const has = s.selected.includes(opt);
      update(idx, {
        selected: has
          ? s.selected.filter((o) => o !== opt)
          : [...s.selected, opt],
      });
    }
  };

  const toggleOther = (q: AskUserQuestionSpec, idx: number) => {
    const s = states[idx];
    if (q.kind === "single") {
      update(idx, { otherSelected: !s.otherSelected, selected: [] });
    } else {
      update(idx, { otherSelected: !s.otherSelected });
    }
  };

  const submit = () => {
    if (!questions.every((q, i) => isAnswered(q, states[i]))) return;
    onSubmit({
      answers: questions.map((q, i) => buildAnswer(q, states[i], i)),
    });
  };

  const renderOptions = (q: AskUserQuestionSpec, idx: number) => {
    const s = states[idx];
    return (
      <div className="flex flex-col gap-1.5">
        {q.options.map((opt) => {
          const checked = s.selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              role={q.kind === "single" ? "radio" : "checkbox"}
              aria-checked={checked}
              onClick={() => toggleOption(q, idx, opt)}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors",
                checked
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background hover:bg-accent",
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center border text-primary",
                  q.kind === "single" ? "rounded-full" : "rounded-sm",
                  checked ? "border-primary" : "border-border",
                )}
              >
                {checked && (
                  <span
                    className={cn(
                      "bg-primary",
                      q.kind === "single"
                        ? "h-2 w-2 rounded-full"
                        : "h-2.5 w-2.5 rounded-[1px]",
                    )}
                  />
                )}
              </span>
              <span>{opt}</span>
            </button>
          );
        })}
        {q.allowFreeText && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
            <Checkbox
              checked={s.otherSelected}
              onCheckedChange={() => toggleOther(q, idx)}
              aria-label={t("chat.userQuestion.other")}
            />
            <span className="shrink-0 text-sm text-muted-foreground">
              {t("chat.userQuestion.other")}
            </span>
            <input
              type="text"
              value={s.text}
              onChange={(e) => update(idx, { text: e.target.value })}
              onFocus={() => !s.otherSelected && toggleOther(q, idx)}
              placeholder={t("chat.userQuestion.otherPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </div>
        )}
      </div>
    );
  };

  const renderField = (q: AskUserQuestionSpec, idx: number) => {
    if (q.kind === "text") {
      return (
        <textarea
          value={states[idx].text}
          onChange={(e) => update(idx, { text: e.target.value })}
          placeholder={t("chat.userQuestion.textPlaceholder")}
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/60"
        />
      );
    }
    return renderOptions(q, idx);
  };

  return (
    <motion.div
      data-testid="user-question-card"
      variants={VARIANTS.slideUp}
      initial="initial"
      animate="animate"
      transition={
        reduced
          ? { duration: 0 }
          : { duration: DURATIONS.normal, ease: EASINGS.easeOut }
      }
      className="rounded-lg border border-primary/40 bg-muted/40 p-3 text-sm shadow-sm"
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary">
        <span aria-hidden>❓</span>
        <span>{t("chat.userQuestion.title")}</span>
        {isWizard && (
          <span className="ml-auto text-muted-foreground">
            {t("chat.userQuestion.step", {
              current: step + 1,
              total: questions.length,
            })}
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {current.header && (
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {current.header}
          </div>
        )}
        <div className="whitespace-pre-wrap text-foreground">
          {current.question}
        </div>
        <div className="pt-1">{renderField(current, step)}</div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {isWizard && step > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            {t("chat.userQuestion.back")}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onSkip}
          className="text-muted-foreground"
        >
          {t("chat.userQuestion.skip")}
        </Button>
        <div className="ml-auto">
          {isWizard && !isLast ? (
            <Button
              type="button"
              size="sm"
              disabled={!currentAnswered}
              onClick={() =>
                setStep((s) => Math.min(questions.length - 1, s + 1))
              }
            >
              {t("chat.userQuestion.next")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              data-testid="user-question-submit"
              disabled={!currentAnswered}
              onClick={submit}
            >
              {t("chat.userQuestion.submit")}
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
