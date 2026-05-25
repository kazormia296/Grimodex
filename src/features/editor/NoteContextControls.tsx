import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexContextMode } from "@/db/schema";
import { ContextModeSelector } from "@/features/codex/components/ContextModeSelector";
import { AliasesField } from "@/features/codex/components/AliasesField";
import { ExcludedAliasesField } from "@/features/codex/components/ExcludedAliasesField";
import { updateNode } from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";

interface NoteContextControlsProps {
  nodeId: string;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

export function NoteContextControls({ nodeId }: NoteContextControlsProps) {
  const { t } = useTranslation();
  const node = useTreeStore((s) => s.nodes.find((n) => n.id === nodeId));
  const [contextMode, setContextMode] = useState<CodexContextMode>("mentioned");
  const [aliases, setAliases] = useState<string[]>([]);
  const [excludedAliases, setExcludedAliases] = useState<string[]>([]);

  useEffect(() => {
    if (!node) return;
    setContextMode((node.contextMode as CodexContextMode) ?? "mentioned");
    setAliases(parseJsonArray(node.aliases));
    setExcludedAliases(parseJsonArray(node.excludedAliases));
  }, [node]);

  const persist = useCallback(
    async (patch: {
      contextMode?: CodexContextMode;
      aliases?: string[];
      excludedAliases?: string[];
    }) => {
      await updateNode(nodeId, {
        ...(patch.contextMode !== undefined && {
          contextMode: patch.contextMode,
        }),
        ...(patch.aliases !== undefined && {
          aliases: JSON.stringify(patch.aliases),
        }),
        ...(patch.excludedAliases !== undefined && {
          excludedAliases: JSON.stringify(patch.excludedAliases),
        }),
      });
      useTreeStore.setState((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                ...(patch.contextMode !== undefined && {
                  contextMode: patch.contextMode,
                }),
                ...(patch.aliases !== undefined && {
                  aliases: JSON.stringify(patch.aliases),
                }),
                ...(patch.excludedAliases !== undefined && {
                  excludedAliases: JSON.stringify(patch.excludedAliases),
                }),
              }
            : n,
        ),
      }));
    },
    [nodeId],
  );

  if (!node || node.nodeType !== "note") return null;

  return (
    <div className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-2">
      <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
        {t("editor.noteContext.title")}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <ContextModeSelector
          value={contextMode}
          onChange={(mode) => {
            setContextMode(mode);
            void persist({ contextMode: mode });
          }}
        />
        <AliasesField
          label={t("codex.aliasesLabel")}
          aliases={aliases}
          onChange={(next) => {
            setAliases(next);
            void persist({ aliases: next });
          }}
        />
        <ExcludedAliasesField
          excludedAliases={excludedAliases}
          onChange={(next) => {
            setExcludedAliases(next);
            void persist({ excludedAliases: next });
          }}
        />
      </div>
    </div>
  );
}
