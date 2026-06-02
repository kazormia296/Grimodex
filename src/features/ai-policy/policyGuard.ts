import { toast } from "sonner";
import i18next from "@/lib/i18n";
import {
  useProjectStore,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { parseAiPolicy } from "./parse";
import { aiDisabledReasonTooltipKey } from "./evaluateAiCapability";
import type { AiFeature } from "./types";

/**
 * 指定 AI 機能が現在のプロジェクトのポリシーで OFF かを **同期** で返す。
 *
 * React 外の実行時チョークポイント（inline AI / Beat の generate、chat の
 * sendMessage、校閲 run）が、UI の hide/disable とは独立に「実アクションを
 * 弾く」ために使う defense 層。これにより hide した affordance の裏側を
 * slash / Enter / 内部再入から発火させる経路を物理的に塞ぐ。
 *
 * 判定は **readiness 非依存**で policy トグルを直接見る。
 * `evaluateAiCapability` は readiness=pending を policy より先に返すため、
 * provider 探索中の窓で policy=off がすり抜けうる。enforcement では
 * その窓に依存せず policy だけを見るのが正しい。
 *
 * policy 取得は projectStore の同期キャッシュ（保存時 refreshProjects で
 * 最新化）から。欠損／破損 policy は parseAiPolicy が DEFAULT(full) に倒す
 * fail-open ＝ DB hiccup で執筆フローを止めない意図的判断。
 */
export function isAiFeatureBlockedByPolicy(feature: AiFeature): boolean {
  const projectId = getCurrentProjectId();
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId);
  const policy = parseAiPolicy(project?.aiPolicy);
  return !policy.toggles[feature];
}

/**
 * policy で OFF の機能アクションを弾く defense ヘルパー。
 * ブロックした場合は policy 理由を toast し `true` を返す。各チョークポイントは
 * `if (blockIfPolicyOff("chat")) return;` の形で実アクションの前に早期 return する。
 *
 * presentation（hide/disable）から独立した correctness 層。これにより
 * 「hide した／disabled のはずのアクションが slash・Enter・内部再入・将来の
 * 自動実行から発火する」事故を、presentation のバグに依存せず防ぐ。
 */
export function blockIfPolicyOff(feature: AiFeature): boolean {
  if (!isAiFeatureBlockedByPolicy(feature)) return false;
  toast.error(i18next.t(aiDisabledReasonTooltipKey("policy")));
  return true;
}
