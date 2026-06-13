import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Snippet } from "@/features/snippets/api";
import { prosemirrorToText } from "@/lib/prosemirror";

export function SnippetCardBody({ snippet }: { snippet: Snippet }) {
  const { t } = useTranslation();
  const plainText = useMemo(
    () => prosemirrorToText(snippet.content),
    [snippet.content],
  );
  return (
    <>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
        {plainText}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {snippet.contentSource === "ai" ? (
          <span className="rounded-full bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-400">
            AI
          </span>
        ) : snippet.contentSource === "human" ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Human
          </span>
        ) : null}
        <span className="text-[10px] text-muted-foreground">
          {plainText.length} {t("common.unitChars")}
        </span>
      </div>
    </>
  );
}
