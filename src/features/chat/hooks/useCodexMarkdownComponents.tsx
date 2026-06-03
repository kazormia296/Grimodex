import { useMemo } from "react";
import type { ReactNode } from "react";
import React from "react";
import type { Components } from "react-markdown";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { createCodexMatcher } from "@/features/codex/codexMatcher";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";
import { SAFE_COMPONENTS } from "@/features/chat/components/safeMarkdown";

/**
 * ReactMarkdown の children ノードを再帰的に走査し、
 * 文字列ノードに Codex ハイライトを適用する。
 */
function processNode(
  node: ReactNode,
  highlightText: (text: string) => ReactNode,
): ReactNode {
  if (typeof node === "string") return highlightText(node);
  if (!React.isValidElement(node)) return node;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as React.ReactElement<any>;
  const { children } = el.props as { children?: ReactNode };
  if (children == null) return el;

  const processed = Array.isArray(children)
    ? children.map((c: ReactNode) => processNode(c, highlightText))
    : processNode(children, highlightText);

  return React.cloneElement(el, { children: processed });
}

/**
 * ReactMarkdown の各ブロック要素の children に Codex ハイライトを適用する
 * components prop オブジェクトを返す hook。
 */
export function useCodexMarkdownComponents(): Components {
  const entries = useCodexStore((s) => s.entries);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const highlightStyle = useSettingsStore((s) =>
    s.get("display.codexHighlightStyle", "color-text"),
  );
  const enabled = useCodexHighlightStore((s) => s.enabled);

  return useMemo(() => {
    // Codex ハイライトが無効/該当なしでも、安全 markdown (a/img) は必ず適用する。
    if (!enabled || entries.length === 0) return SAFE_COMPONENTS;

    const matcher = createCodexMatcher(entries);

    function highlightText(text: string): ReactNode {
      const matches = matcher(text);
      if (matches.length === 0) return text;

      const parts: ReactNode[] = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.from > cursor) parts.push(text.slice(cursor, match.from));

        const colors: ResolvedCodexColor = typeColorMap[match.entryType] ?? {
          hl: "#88888829",
          tx: "#888888",
          fg: "#888888",
        };
        const style: React.CSSProperties =
          highlightStyle === "underline"
            ? {
                textDecoration: "underline",
                textDecorationColor: colors.fg,
                textUnderlineOffset: "3px",
              }
            : {
                backgroundColor: colors.hl,
                color: colors.tx,
                borderRadius: "3px",
                padding: "0 2px",
              };

        parts.push(
          <span
            key={`codex-hl-${match.from}`}
            className="codex-highlight"
            data-codex-entry-id={match.entryId}
            data-codex-entry-type={match.entryType}
            data-codex-entry-name={match.entryName}
            style={style}
          >
            {text.slice(match.from, match.to)}
          </span>,
        );
        cursor = match.to;
      }
      if (cursor < text.length) parts.push(text.slice(cursor));
      return parts;
    }

    function wrap(children: ReactNode): ReactNode {
      if (Array.isArray(children))
        return children.map((c: ReactNode) => processNode(c, highlightText));
      return processNode(children, highlightText);
    }

    return {
      ...SAFE_COMPONENTS,
      p: ({ children }: { children: ReactNode }) => <p>{wrap(children)}</p>,
      li: ({ children }: { children: ReactNode }) => <li>{wrap(children)}</li>,
      h1: ({ children }: { children: ReactNode }) => <h1>{wrap(children)}</h1>,
      h2: ({ children }: { children: ReactNode }) => <h2>{wrap(children)}</h2>,
      h3: ({ children }: { children: ReactNode }) => <h3>{wrap(children)}</h3>,
      h4: ({ children }: { children: ReactNode }) => <h4>{wrap(children)}</h4>,
      h5: ({ children }: { children: ReactNode }) => <h5>{wrap(children)}</h5>,
      h6: ({ children }: { children: ReactNode }) => <h6>{wrap(children)}</h6>,
      td: ({ children }: { children: ReactNode }) => <td>{wrap(children)}</td>,
      th: ({ children }: { children: ReactNode }) => <th>{wrap(children)}</th>,
      blockquote: ({ children }: { children: ReactNode }) => (
        <blockquote>{wrap(children)}</blockquote>
      ),
    } as Components;
  }, [entries, typeColorMap, highlightStyle, enabled]);
}
