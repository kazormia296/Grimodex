import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; content: string };

interface Props {
  /** public/ 直下のファイル名 (例: "TERMS_ja.md") */
  src: string;
}

export function MarkdownDoc({ src }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`/${src}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((content) => {
        if (!cancelled) setState({ status: "ok", content });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (state.status === "loading") {
    return (
      <div className="py-4 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="py-4 text-sm text-destructive">
        {t("settings.about.docLoadError", { message: state.message })}
      </div>
    );
  }

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.content}</ReactMarkdown>
    </div>
  );
}
