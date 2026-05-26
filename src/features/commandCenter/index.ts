/**
 * CommandCenter 公開 API。
 * - 検索バー (CommandCenterBar) はアプリヘッダー中央に常駐
 * - lexical/semantic Provider を起動時に登録 (副作用 import)
 */
export { CommandCenterBar } from "./CommandCenterBar";
export {
  selectPopoverOpen,
  useBarStore,
  usePanelStore,
  /** @deprecated bar 用 store の旧名。新規コードでは useBarStore を使う。 */
  useCommandCenterStore,
} from "./store/commandCenterStore";
export { useResultsPanelStore } from "./store/resultsPanelStore";
export type { CommandCenterMode } from "./providers/types";

import { registerProvider } from "./providers/registry";
import { lexicalSearchProvider } from "./providers/lexicalSearchProvider";
import { semanticSearchProvider } from "./providers/semanticSearchProvider";

registerProvider(lexicalSearchProvider);
registerProvider(semanticSearchProvider);
