import { isElectron } from "@/lib/shell";
import type { ModelCapabilitySnapshotView } from "@/lib/modelCapabilitySnapshot";
import type { AiProvider } from "../types";

/**
 * 共有 registry（main が取得・同梱するモデル能力の写し）の renderer 側の保持（PR-C3）。
 *
 * 使うのは context・最大出力・tool の 3 つだけ。写しの `reasoning` は持たない：thinking・effort の
 * 送り方は provider 別の製品の判断で決め、真偽値 1 つで決めない（親文書 §3、precheck §7.1）。
 *
 * 能力表に無い id にだけ重ねる規則は modelLimits.ts（`applyRegistryCaps`）が持つ。ここは
 * 「provider ＋ id の完全一致で引く」ことと、「読めなければ無い扱い」だけを担う。
 */
export interface RegistryModelCaps {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly toolCall?: boolean;
}

/**
 * 写しの provider（`SNAPSHOT_PROVIDERS`）と同じ集合。electron/shared の検証 module は
 * 起動の chunk に載せないので、ここに写しを持ち、同じであることは試験が確かめる。
 */
export const REGISTRY_CAPS_PROVIDERS: ReadonlySet<AiProvider> =
  new Set<AiProvider>(["anthropic", "openai", "openrouter", "sakana"]);

/** key は `<provider>/<model id>`。null は「層が無い」（Web 版、読めなかった、まだ読んでいない）。 */
let entries: ReadonlyMap<string, RegistryModelCaps> | null = null;
let loading: Promise<boolean> | null = null;

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * main が返した写しを保持する。対応する provider の key だけを、3 つの field に絞って写す
 * （main の検証済みの値でも、ここで形を確かめ直す）。使える field が 1 つも無い項目は持たない。
 * 保持したら true。
 */
export function setRegistryModelCaps(
  view: Pick<ModelCapabilitySnapshotView, "models">,
): boolean {
  const next = new Map<string, RegistryModelCaps>();
  for (const [key, raw] of Object.entries(view.models)) {
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) continue;
    if (!REGISTRY_CAPS_PROVIDERS.has(key.slice(0, slash) as AiProvider)) {
      continue;
    }
    const contextWindow = positiveSafeInteger(raw.contextWindow);
    const maxOutputTokens = positiveSafeInteger(raw.maxOutputTokens);
    const toolCall =
      typeof raw.toolCall === "boolean" ? raw.toolCall : undefined;
    if (
      contextWindow === undefined &&
      maxOutputTokens === undefined &&
      toolCall === undefined
    ) {
      continue;
    }
    next.set(key, {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(toolCall !== undefined ? { toolCall } : {}),
    });
  }
  entries = next;
  return true;
}

/**
 * provider と id の完全一致で引く。前方一致・ドット／ダッシュの正規化はしない（表に載っているかの
 * 判定は modelLimits.ts の既存の規則が行う）。OpenRouter だけ、旧い `openrouter/` の prefix を
 * 付けた id も、写しの key（`openrouter/<id>`）に完全一致しなければ prefix を外して引く
 * （dynamicModelCaps と同じ）。
 */
export function getRegistryModelCaps(
  provider: AiProvider,
  modelId: string,
): RegistryModelCaps | null {
  if (entries === null || !REGISTRY_CAPS_PROVIDERS.has(provider)) return null;
  const exact = entries.get(`${provider}/${modelId}`);
  if (exact) return exact;
  if (provider === "openrouter" && modelId.startsWith("openrouter/")) {
    return (
      entries.get(`openrouter/${modelId.slice("openrouter/".length)}`) ?? null
    );
  }
  return null;
}

async function loadOnce(): Promise<boolean> {
  try {
    // Electron 以外（Web 版）は写しが無い。IPC の wrapper の chunk も読まない。
    if (!isElectron()) return false;
    // 検証 module を含むので、起動の graph に載せない。
    const { getModelCapabilitySnapshot } =
      await import("@/lib/modelCapabilitySnapshot");
    const view = await getModelCapabilitySnapshot();
    return view === null ? false : setRegistryModelCaps(view);
  } catch {
    // 同梱も cache も使えない・IPC の失敗は、registry の層が無い扱い（今の挙動のまま）。
    return false;
  }
}

/**
 * 写しを 1 回だけ読む（single-flight。失敗しても読み直さない）。読み込みを始めた最初の呼び出しだけが、
 * 読めたときに `onLoaded` を呼ぶ（呼び出し側が再描画の合図を 1 回だけ出すため）。2 回目以降は
 * 同じ promise を返し、`onLoaded` は呼ばない。promise は reject しない。
 *
 * main の取得で cache が更新されても renderer へは通知しない（新しい契約になるため）。反映は次の起動。
 */
export function startRegistryModelCapsLoad(
  onLoaded?: () => void,
): Promise<boolean> {
  if (loading !== null) return loading;
  loading = loadOnce().then((loaded) => {
    if (loaded) onLoaded?.();
    return loaded;
  });
  return loading;
}

/** Test-only reset（保持した写しと、読み込みの済み印）。 */
export function __resetRegistryModelCapsForTests(): void {
  entries = null;
  loading = null;
}
