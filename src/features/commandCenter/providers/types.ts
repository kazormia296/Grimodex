/** Dockview 検索パネルで使う検索 provider の型定義。 */

export type ItemKind =
  | "lexical-scene"
  | "lexical-codex"
  | "lexical-snippet"
  | "semantic-chunk";

export type BadgeTone = "scene" | "codex" | "snippet" | "score";

export interface CommandCenterItem {
  /** `${kind}:${nativeId}` 形式 */
  id: string;
  kind: ItemKind;
  title: string;
  subtitle?: string;
  badge?: { label: string; tone: BadgeTone };
  onSelect: () => void;
}

export type SectionState =
  | { kind: "idle" }
  | { kind: "loading"; message?: string }
  | { kind: "error"; message: string };

export interface CommandCenterSection {
  /** "lexical" | "semantic" など provider id と対応 */
  id: string;
  title: string;
  order: number;
  items: CommandCenterItem[];
  state?: SectionState;
}

/** cacheKeyExtras / search に渡される provider extras。store を直接読まずに済むよう DI する。 */
export interface ProviderExtras {
  /** semantic の dialogue penalty */
  descriptionMode: boolean;
}

export interface ProviderSearchContext extends ProviderExtras {
  /** prefix を剥がした生クエリ */
  query: string;
  /** 旧クエリの結果を捨てるための補助シグナル */
  signal: AbortSignal;
  /** 1 provider あたりの取得件数 */
  limit: number;
  /** 世代 ID。応答受信時に provider 側で照合してから upsert する想定 */
  generation: number;
}

export interface CommandCenterProvider {
  id: string;
  /** Section の表示順 (小さいほど上)。Lexical=1, Semantic=2 */
  order: number;
  /** Section title (i18n キー解決済みの文字列を返す) */
  title: string;
  /** 0 件の section を結果配列から除外するか */
  hideWhenEmpty: boolean;
  search: (ctx: ProviderSearchContext) => Promise<CommandCenterSection>;
  /**
   * Provider 固有の memo bust factor。`useCommandCenterSearch` が
   * baseKey に組み込むため、変化したときだけこの provider が再 fetch される
   * (他の provider は無関係に維持)。例: Semantic は descriptionMode を含める。
   * 戻り値の string を `baseKey` に concat。default: 何も追加しない。
   */
  cacheKeyExtras?: (extras: ProviderExtras) => string;
}
