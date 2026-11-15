import {
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";
import { resolveCommandContext } from "@/features/commands/commandContext";
import { runAppCommand } from "@/features/commands/appCommandRegistry";
import { isMac } from "@/lib/platform";

/**
 * Handles desktop editor-tab cycling. Phone workspaces deliberately project a
 * single active document and must never mutate the hidden desktop tab model.
 *
 * キーの照合だけを持つ。タブを切り替える動作は registry の nextTab／prevTab。
 */
export function handleEditorTabSwitchKeydown(
  event: KeyboardEvent,
  phoneWorkspace: boolean,
): boolean {
  if (phoneWorkspace) return false;

  const merged = getMergedBindings();
  const mac = isMac();
  const isPrevious = matchesBinding(event, merged.prevTab ?? "", mac);
  const isNext = matchesBinding(event, merged.nextTab ?? "", mac);
  if (!isPrevious && !isNext) return false;
  event.preventDefault();

  runAppCommand(
    isPrevious ? "prevTab" : "nextTab",
    resolveCommandContext({ phoneWorkspace }),
  );
  return true;
}
