// MP-3c: the turn owner's wiring, held as text (the pieces are tested one by
// one elsewhere; this keeps them joined). A missing joint is a silent hole:
// a turn that survives a profile restriction, a workspace switch or a quit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** The code without comments (a comment may name what the code must not do). */
const codeOf = (rel: string): string =>
  fs
    .readFileSync(path.join(repoRoot, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ");

const INDEX = codeOf("electron/main/index.ts");
const IPC = codeOf("electron/main/ipc.ts");
const OWNER = codeOf("electron/main/mastraTurnOwner.ts");
const ADAPTER = codeOf("electron/main/mastra/agentToolAdapter.ts");

describe("index.ts: the owner is an egress participant, a quit step and an event observer", () => {
  it("is registered as a main egress participant with both its quiesce (taking the gate's context) and its force stop", () => {
    expect(INDEX).toMatch(
      /profileEgress\.registerMainEgressParticipant\( "mastra-turn-owner", \(context\) => mastraTurnOwner\.quiesceForProfileEgress\(context\), \(\) => mastraTurnOwner\.forceStopForProfileEgress\(\), \);/,
    );
    // Inside the block of the existing participants (not registered in a launch whose gate is unavailable).
    const block =
      /if \(!profileEgress\.unavailable\) \{(.*?)\} \/\/ DA-2|if \(!profileEgress\.unavailable\) \{(.*?)\}\s*const aiStreamTerminals/.exec(
        INDEX,
      );
    const registered = (block?.[1] ?? block?.[2] ?? INDEX).includes(
      '"mastra-turn-owner"',
    );
    expect(registered).toBe(true);
    expect(INDEX).toMatch(/registerMainEgressParticipant\( "cli-ai"/);
  });

  it("the quit finalizer ends the turns in dispose (before Native's shutdown) and in complete", () => {
    // dispose: the owner's shutdown is one of the things Native's shutdown waits for.
    expect(INDEX).toMatch(
      /const mastraResult = Promise\.resolve\(\)\.then\(\(\) => mastraTurnOwner\.shutdown\(\),? \);/,
    );
    expect(INDEX).toMatch(
      /const nativeResult = Promise\.all\(\[ rendererTeardown, coordinatorResult, schedulerResult, freshnessResult, mastraResult, \]\)\s*\.then\(\(\) => backend\?\.shutdownWorkspaceLifecycle\?\.\(\)\)/,
    );
    // complete: the same call, in the list of independent cleanups.
    expect(INDEX).toMatch(
      /runIndependentShutdownCleanups\(\[[^\]]*\(\) => mastraTurnOwner\.shutdown\(\),? \]\)/,
    );
  });

  it("the backend event observer tells the owner (a replaced workspace binding ends its turns)", () => {
    expect(INDEX).toMatch(
      /narrativeMaintenanceTriggers\?\.handleBackendEvent\(channel, payload\); (?:\/\/[^;]*)?mastraTurnOwner\.handleBackendEvent\(channel, payload\);/,
    );
  });

  it("the owner and the loader are made once, closed under the same condition as the router's gate, and the router gets the owner", () => {
    expect(INDEX).toMatch(
      /const mastraAgentTurnLaunch = nir1LocalGenerationLaunchFromApp\(\);/,
    );
    expect(INDEX).toMatch(
      /const mastraAgentTurnOpen = openMastraAgentTurnGate\(\{ seam: parseMastraAgentTurnCiSeam\(mastraAgentTurnLaunch\), isPackaged: mastraAgentTurnLaunch\.isPackaged, \}\);/,
    );
    expect(INDEX).toMatch(
      /createMastraAgentLoader\(\{ isOpen: \(\) => mastraAgentTurnOpen, \}\)/,
    );
    expect(INDEX).toMatch(
      /createMastraTurnOwner\(\{ open: mastraAgentTurnOpen,/,
    );
    expect(INDEX).toMatch(
      /tokenizer: createMainO200kTokenizer\(\(\) => resolveMainTokenizerAssetPaths\(\{ isPackaged: app\.isPackaged, resourcesPath: process\.resourcesPath, mainDir: __dirname, \}\), \),/,
    );
    expect(INDEX).toMatch(/loadRuntime: \(\) => mastraAgentLoader\.load\(\),/);
    expect(INDEX).toMatch(
      /loadReadBindings: \(\) => import\("\.\/mastraTurnReadBindings\.js"\),/,
    );
    expect(INDEX).toMatch(
      /aiStreamTerminals, mastraAgentTurnLaunch, mastraTurnOwner, \);/,
    );
    // One owner and one loader in the whole product.
    for (const file of fs.readdirSync(path.join(repoRoot, "electron/main"))) {
      if (!/\.ts$/.test(file) || /\.(test|spec|testSupport)\.ts$/.test(file)) {
        continue;
      }
      // index.ts makes them; the two modules define them.
      if (
        ["index.ts", "mastraTurnOwner.ts", "mastraAgentLoader.ts"].includes(
          file,
        )
      ) {
        continue;
      }
      const text = codeOf(`electron/main/${file}`);
      expect(text, file).not.toMatch(
        /createMastraTurnOwner\(|createMastraAgentLoader\(/,
      );
    }
  });
});

describe("ipc.ts: the router hands the owner its invoke and its workspace-switch lease", () => {
  it("the shell handlers come from the route with the invoke's sender, window and issued identity (never the context-less ones)", () => {
    expect(IPC).toMatch(
      /\.\.\.\(isMastraAgentTurnCommand\(cmd\) \|\| cmd === MASTRA_AGENT_TURN_ANSWER_COMMAND \? mastraAgentTurn\.handlersFor\(\{ sender: event\.sender, win, callerIdentity, \}\) : \{\}\),/,
    );
    expect(IPC).not.toMatch(/\.\.\.mastraAgentTurn\.handlers[^F]/);
    expect(IPC).toMatch(/owner: mastraTurnOwner,/);
  });

  it("a workspace switch takes the owner's lease first, inside the switch branch and before the maintenance lease", () => {
    const branch = IPC.slice(
      IPC.indexOf("if (WORKSPACE_SWITCH_COMMANDS.has(cmd))"),
    );
    const owner = branch.indexOf(
      "mastraTurnOwner?.quiesceForWorkspaceSwitch?.()",
    );
    const maintenance = branch.indexOf(
      "narrativeMaintenance?.quiesceForWorkspaceSwitch?.()",
    );
    const open = branch.indexOf("await dispatch()");
    expect(owner).toBeGreaterThan(0);
    expect(owner).toBeLessThan(maintenance);
    // Before Native's open (the dispatch), where the old workspace can still be written.
    expect(maintenance).toBeLessThan(open);
    expect(branch).toMatch(/if \(mastraLease\) acquired\.push\(mastraLease\);/);
    // The lease is resumed with the others, after the switch (success or failure).
    expect(IPC).toMatch(/await lease\.resume\(envelope\.ok\);/);
  });
});

describe("the owner module", () => {
  it("imports no @mastra, no Electron and no child process; the runtime comes only through its injected loader", () => {
    expect(OWNER).not.toMatch(/@mastra/);
    expect(OWNER).not.toMatch(/from "electron"/);
    expect(OWNER).not.toMatch(/node:child_process|node:net|node:http/);
    expect(OWNER).not.toMatch(/mastra-agent|require\(/);
  });

  it("never forwards the caller identity to Native, and never issues a capability", () => {
    expect(OWNER).toMatch(
      /const \{ callerIdentity: _identity, \.\.\.nativeArgs \} = args;/,
    );
    expect(OWNER).not.toMatch(
      /issueAgentAuthorityCapabilities|agentAuthorityCapabilities/,
    );
  });

  it("binds the shared seven UI definitions through the one-shot question registry", () => {
    expect(OWNER).toMatch(/createMastraUiToolDefinitions\(\)/);
    expect(OWNER).toMatch(/MASTRA_UI_TOOL_NAMES\.find/);
    expect(OWNER).toMatch(
      /requestUiTool\( turn\.turnId, toolCallId, name, args as Readonly<Record<string, unknown>>, \)/,
    );
    expect(OWNER).toMatch(/result\.content == null \? result\.summary/);
    expect(OWNER).toMatch(/JSON\.stringify\(result\.content\)/);
  });

  it("does not read Mastra resume or approval context as a UI answer", () => {
    for (const source of [OWNER, ADAPTER]) {
      expect(source).not.toMatch(/\b(?:resumeData|approved)\b/u);
    }
  });
});
