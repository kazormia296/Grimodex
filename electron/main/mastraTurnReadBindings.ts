import type { M4ReadToolName } from "../shared/agentReadToolDefinitions.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import type { MastraAgentTurnStartRequest } from "../shared/mastraAgentTurnWire.js";
import type { CoreTokenizer } from "../shared/mastraRead/tokenizer.js";
import type {
  CoreReadContext,
  CoreTreeState,
} from "../shared/mastraRead/ports.js";
import { createCoreReadDb } from "../shared/readDomain/core/readDb.js";
import { createDbSceneBodyReader } from "../shared/readDomain/core/sceneBody.js";
import {
  createMainChronicleReadContext,
  createMainChronicleSearchContext,
} from "../shared/readDomain/core/chronicleMainContext.js";
import {
  createMainCodexEntryContext,
  createMainCodexReadContext,
} from "../shared/readDomain/core/codexMainContext.js";
import {
  createChronicleReadExecutors,
  createChronicleSearchExecutors,
} from "../shared/readDomain/core/chronicleReadExecutors.js";
import { createCodexEntryExecutors } from "../shared/readDomain/core/codexEntryExecutors.js";
import { createCodexReadExecutors } from "../shared/readDomain/core/codexReadExecutors.js";
import { readChronicleReadInputs } from "../shared/readDomain/core/readInputsReader.js";
import { createReadExecutors } from "../shared/readDomain/core/readExecutors.js";
import {
  ALREADY_INJECTED_CODEX_ENTRY_SUMMARY,
  alreadyInjectedCodexEntryContent,
} from "../shared/readDomain/features/codex/alreadyInjectedEntry.js";
import { extractPlainText } from "../shared/readDomain/features/codex/prosemirrorTextExtractor.js";
import type { CoreReadExecutor } from "../shared/readDomain/core/toolResult.js";
import type { MastraAgentToolBinding } from "./mastra/agentRuntime.js";
import { createMainReadDb } from "./mastraRead/db.js";
import { createMainTypedReads } from "./mastraRead/typed.js";
import type { MainReadHooks } from "./mastraRead/nativeCall.js";
import type { MainIssuedCallerIdentity } from "./profileEgress.js";

interface ReadToolDefinition {
  readonly name: string;
  readonly description: string;
}

type M4TurnReadRequest = Omit<MastraAgentTurnStartRequest, "tools"> & {
  readonly tools: readonly M4ReadToolName[];
};

export async function createTurnReadBindings(options: {
  readonly backend: NapiBackendLike;
  readonly identity: MainIssuedCallerIdentity;
  readonly hooks: MainReadHooks;
  readonly request: M4TurnReadRequest;
  readonly projectId: string;
  readonly currentSceneId: string | null;
  readonly tokenizer: CoreTokenizer;
  readonly toolDefinitions: readonly ReadToolDefinition[];
}): Promise<{
  readonly bindings: MastraAgentToolBinding[];
  readonly clear: () => void;
}> {
  const {
    backend,
    identity,
    hooks,
    request,
    projectId,
    currentSceneId,
    tokenizer,
    toolDefinitions,
  } = options;
  const definitions = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  const db = createCoreReadDb(
    createMainReadDb({ backend, identity, ...hooks }),
  );
  const native = createMainTypedReads({ backend, identity, ...hooks });
  const turnInputs = await readChronicleReadInputs(db, {
    projectId,
    currentSceneId,
  });
  const countTokens = (text: string): number => tokenizer.countTokens(text);
  const treeState: CoreTreeState = {
    projectId: turnInputs.inputs.projectId,
    nodes: turnInputs.nodes,
    activeSceneId: turnInputs.inputs.currentSceneId,
  };
  const readContext: CoreReadContext = {
    getDb: () => db,
    getTreeState: () => treeState,
    body: createDbSceneBodyReader(() => db),
    native,
    countTokens,
  };
  const chronicle = createMainChronicleReadContext({
    db,
    turn: turnInputs,
    countTokens,
    getUiLanguage: () => request.loop.language,
  });
  const executors: Readonly<Record<M4ReadToolName, CoreReadExecutor>> = {
    ...createReadExecutors(readContext),
    ...createCodexReadExecutors(
      createMainCodexReadContext({
        db,
        inputs: turnInputs.inputs,
        countTokens,
        native,
      }),
    ),
    ...createCodexEntryExecutors(
      createMainCodexEntryContext({
        db,
        inputs: turnInputs.inputs,
        countTokens,
        extractPlainText,
      }),
    ),
    ...createChronicleReadExecutors(chronicle.ctx),
    ...createChronicleSearchExecutors(
      createMainChronicleSearchContext({
        db,
        turn: turnInputs,
        countTokens,
        native,
      }),
    ),
  };
  const bindings = request.tools.map((name): MastraAgentToolBinding => {
    const definition = definitions.get(name);
    const execute = executors[name];
    if (!definition || !execute)
      throw new Error("MASTRA_AGENT_READ_TOOL_UNAVAILABLE");
    return {
      name,
      description: definition.description,
      async execute(args) {
        if (
          name === "get_codex_entry" &&
          typeof args === "object" &&
          args !== null &&
          !Array.isArray(args)
        ) {
          const id = String((args as Record<string, unknown>)["id"] ?? "");
          if (id && request.fullyInjectedIds.includes(id)) {
            const content = alreadyInjectedCodexEntryContent(id);
            const text = JSON.stringify(content);
            return {
              text,
              tokensUsed: countTokens(text),
              summary: ALREADY_INJECTED_CODEX_ENTRY_SUMMARY,
            };
          }
        }
        const result = await execute(args as Record<string, unknown>);
        if (
          "error" in result &&
          result.error !== undefined &&
          result.error !== null
        ) {
          throw new Error(String(result.error));
        }
        return {
          text:
            result.content == null
              ? result.summary || "No result (not found)."
              : JSON.stringify(result.content)!,
          tokensUsed: result.tokensUsed,
          summary: result.summary,
        };
      },
    };
  });
  return { bindings, clear: chronicle.clear };
}
