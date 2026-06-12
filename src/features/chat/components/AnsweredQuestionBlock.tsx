import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AskUserQuestionSpec,
  ToolCallRecord,
  UserQuestionAnswer,
} from "../agent/agentTypes";

interface AnsweredQuestionBlockProps {
  record: ToolCallRecord;
}

interface ParsedSummary {
  answers?: UserQuestionAnswer[];
  dismissed?: boolean;
}

/**
 * ask_user の確定表示（履歴での read-only 再描画）。
 * 機械可読 JSON を埋めた `record.resultSummary` から回答を、`record.params`
 * から元の質問を復元する。parse 失敗時は生 summary を表示してフォールバック。
 */
function parseSummary(summary: string): ParsedSummary | null {
  try {
    const parsed: unknown = JSON.parse(summary);
    if (parsed && typeof parsed === "object") return parsed as ParsedSummary;
  } catch {
    // 旧形式・破損 summary はフォールバック表示へ
  }
  return null;
}

function answerText(a: UserQuestionAnswer): string {
  const parts: string[] = [];
  if (a.selected && a.selected.length > 0) parts.push(a.selected.join(" / "));
  if (a.text) parts.push(a.text);
  return parts.join(" / ");
}

export function AnsweredQuestionBlock({ record }: AnsweredQuestionBlockProps) {
  const { t } = useTranslation();
  const parsed = parseSummary(record.resultSummary);
  const questions =
    (record.params as { questions?: AskUserQuestionSpec[] }).questions ?? [];

  // フォールバック: 構造復元できない場合は生 summary を簡素表示。
  if (!parsed) {
    return (
      <div className="my-1 flex items-center gap-1.5 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
        <CircleHelp className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {t("chat.userQuestion.title")} — {record.resultSummary}
        </span>
      </div>
    );
  }

  const dismissed = parsed.dismissed === true;
  const answers = parsed.answers ?? [];

  return (
    <div className="my-1 rounded border border-border bg-muted/40 text-xs">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <CircleHelp className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground">
          {t("chat.userQuestion.title")}
        </span>
        <span className="ml-auto text-muted-foreground">
          {dismissed
            ? t("chat.userQuestion.dismissed")
            : t("chat.userQuestion.answered")}
        </span>
      </div>
      <div className="space-y-1.5 border-t border-border px-2 py-1.5">
        {dismissed
          ? questions.map((q, i) => (
              <div key={i} className="text-muted-foreground">
                {q.header ? `${q.header}: ` : ""}
                {q.question}
              </div>
            ))
          : answers.map((a, i) => (
              <div key={i}>
                <div className="text-muted-foreground">
                  {a.header ? `${a.header}: ` : ""}
                  {a.question}
                </div>
                <div className="text-foreground">└─ {answerText(a) || "—"}</div>
              </div>
            ))}
      </div>
    </div>
  );
}
