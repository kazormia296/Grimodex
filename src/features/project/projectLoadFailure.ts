import i18next from "@/lib/i18n";
import { toast } from "sonner";

/**
 * Project load actions are often launched from a toast or menu callback that
 * cannot return a rejecting Promise. Terminate the rejection here and keep the
 * existing user-facing switch failure notification consistent across callers.
 */
export async function runProjectLoadWithFailureToast(
  load: () => Promise<void>,
): Promise<void> {
  try {
    await load();
  } catch {
    toast.error(i18next.t("project.switchFailed"));
  }
}
