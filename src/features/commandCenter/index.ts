/**
 * CommandCenter 公開 API。
 * - Dockview の全文検索パネル用 store
 * - lexical/semantic provider を起動時に登録 (副作用 import)
 */
export { usePanelStore } from "./store/commandCenterStore";
export { useResultsPanelStore } from "./store/resultsPanelStore";

import { registerProvider } from "./providers/registry";
import { lexicalSearchProvider } from "./providers/lexicalSearchProvider";
import { semanticSearchProvider } from "./providers/semanticSearchProvider";

registerProvider(lexicalSearchProvider);
registerProvider(semanticSearchProvider);
