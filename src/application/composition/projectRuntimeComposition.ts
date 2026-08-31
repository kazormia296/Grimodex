import { usePhaseStore } from "@/features/codex/phaseStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import type {
  ProjectBackgroundActivation,
  ProjectRuntimePort,
} from "@/application/project/projectRuntime";

async function initializeTimelapse({
  projectId,
  canStart,
  isMutationCurrent,
}: ProjectBackgroundActivation): Promise<void> {
  if (!canStart()) return;
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  if (!workspaceIdentity || !isMutationCurrent()) return;
  const expectedWorkspacePath = workspaceIdentity.path;

  const [toggle, recorder] = await Promise.all([
    import("@/features/timelapse/toggle"),
    import("@/features/timelapse/recorder"),
  ]);
  if (!canStart()) return;

  // Drain the old Project queue before changing the recorder binding.
  if (!isMutationCurrent()) return;
  await recorder.flushNow();
  if (!isMutationCurrent()) return;

  const enabled = await toggle.isTimelapseEnabled(projectId);
  if (!isMutationCurrent()) return;

  recorder.setRecorderEnabled(enabled);
  if (!isMutationCurrent()) return;
  const bound = await recorder.initRecorderForProject(projectId);
  if (!isMutationCurrent()) return;

  if (!enabled || !bound) return;
  await toggle.ensureGenesisBaselines(
    projectId,
    expectedWorkspacePath,
    isMutationCurrent,
  );
  if (!isMutationCurrent()) return;

  const { seedWorkspaceSnapshot } =
    await import("@/features/timelapse/seedSession");
  if (!isMutationCurrent()) return;
  await seedWorkspaceSnapshot(projectId, isMutationCurrent);
}

async function startExternalWriteFeed({
  projectId,
  canStart,
  isMutationCurrent,
}: ProjectBackgroundActivation): Promise<void> {
  if (!canStart()) return;

  const feed = await import("@/features/concurrency/externalWriteFeed");
  if (!canStart()) return;

  await feed.startExternalWriteFeed(projectId);
  if (!isMutationCurrent()) {
    feed.stopExternalWriteFeed();
    return;
  }

  const { setupAutoAcceptProseConsumer, drainProposedProse } =
    await import("@/features/agent-writes/autoAcceptFeed");
  if (!isMutationCurrent()) {
    feed.stopExternalWriteFeed();
    return;
  }

  setupAutoAcceptProseConsumer();
  await drainProposedProse(projectId, isMutationCurrent);
  if (!isMutationCurrent()) {
    feed.stopExternalWriteFeed();
  }
}

export const projectRuntimeComposition: ProjectRuntimePort = {
  applyMetadata: ({ language, phaseResolutionMode }) => {
    if (language && typeof document !== "undefined") {
      document.documentElement.lang = language;
    }
    if (language) {
      useSettingsStore.getState().applyProjectLanguage(language);
    }
    if (phaseResolutionMode) {
      usePhaseStore.getState().setResolutionMode(phaseResolutionMode);
    }
  },
  getFallbackLanguage: () => useSettingsStore.getState().projectLanguage,
  prepareExternalWriteFeedStop: async () => {
    const { stopExternalWriteFeed } =
      await import("@/features/concurrency/externalWriteFeed");
    return stopExternalWriteFeed;
  },
  initializeTimelapse,
  startExternalWriteFeed,
};
