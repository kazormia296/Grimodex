/**
 * Project context atoms — shared fetchers for AI prompt construction.
 *
 * 元々 chat の contextBuilder + chatStore に module-private で住んでいた
 * fetchProjectContext を切り出した共有 atom。Chat は L1〜L6 の layered
 * 構造、Map AI Branch は flat な system+user の 2 メッセージ構造を
 * 自前で組み立てるが、source となる project 情報の整形ロジックだけは
 * 重複しないようここで一元化する。
 *
 * 注意: layer-builder や budget trimmer は consumer 側で持つ。ここに
 * 集約しない (Chat と Map で要件が異なる為)。
 */

import { useTreeStore } from "@/features/tree/treeStore";
import { isBodyWriteDisabled } from "@/features/ai-policy/parse";
import { getProject } from "./api";

export interface ProjectContext {
  title: string;
  genre?: string | null;
  pov?: string | null;
  tense?: string | null;
  styleGuide?: string | null;
  aiInstructions?: string | null;
  language?: string;
  /** Phase 4: 著者手書きの outline。Chat L2 / Map system prompt の
   *  「プロジェクト概要」セクションに使われる想定。 */
  outline?: string | null;
  /** 想定読者プロフィール。校閲 疑似コメント「ターゲット読者層」ペルソナの
   *  brief に注入される (空のとき同ペルソナは選択不可)。 */
  targetReaders?: string | null;
  /** AiPolicy で本文書き込み (bodyWrite) が無効か。Chat の L0 system prompt に
   *  本文代筆抑止指示を出すかどうかの判定に使う (true のとき抑止)。 */
  bodyWriteDisabled?: boolean;
}

/**
 * Project info を AI 生成用に整形して返す共有 atom。
 *
 * @param projectId 明示指定。null/undefined のとき useTreeStore の
 *                  projectId に fallback (chat の旧 fetchProjectContext と
 *                  同等の挙動)。
 */
export async function fetchProjectContext(
  projectId?: string | null,
): Promise<ProjectContext | null> {
  const effectiveId = projectId ?? useTreeStore.getState().projectId;
  if (!effectiveId) return null;
  try {
    const project = await getProject(effectiveId);
    if (!project) return null;
    return {
      title: project.title,
      genre: project.genre,
      pov: project.pov,
      tense: project.tense,
      styleGuide: project.styleGuide,
      aiInstructions: project.aiInstructions,
      language: project.language,
      outline: project.outline,
      targetReaders: project.targetReaders,
      bodyWriteDisabled: isBodyWriteDisabled(project.aiPolicy),
    };
  } catch {
    return null;
  }
}
