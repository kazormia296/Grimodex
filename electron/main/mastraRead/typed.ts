import type {
  DispatchDeps,
  NapiBackendLike,
} from "../../shared/ipcContract.js";
import { NAPI_COMMANDS } from "../../shared/ipcContract.js";
import { MAIN_READ_CALLER_TIMEOUT_MS } from "../../shared/ipcCallerTimeouts.js";
import {
  assertCoreProjectId,
  type CoreNativeReads,
  type FtsScope,
} from "../../shared/mastraRead/ports.js";
import type { MainIssuedCallerIdentity } from "../profileEgress.js";
import { MainReadError } from "./errors.js";
import { runNativeRead, type MainReadHooks } from "./nativeCall.js";

/**
 * Electron main's four typed reads (Mastra migration MP-4b, DR-MP4-6). Each is
 * a named method that calls the argument check and the wire parse of ONE
 * command, spelled as a literal key of `NAPI_COMMANDS`. There is no method that
 * takes a command name: `NAPI_COMMANDS` holds every command, including ones
 * whose gate lives in the router and not in their entry, and a name passed as a
 * variable would be a way around that gate (and around the static test that
 * forbids naming it).
 *
 * `fts_search` takes a scope from a union, checked again at run time. The two
 * semantic reads take `expectedWorkspacePath` from the turn's identity
 * (`workspaceId`), and a backend without the method is refused (fail closed).
 * The renderer checks, after a semantic call, that the workspace is still the
 * same and throws if not; main has no such after-the-fact comparison and
 * replaces it with `assertLive` of the turn's lifecycle, before and after the
 * call (the `hooks`, PR-2).
 *
 * The four commands' `run` take `(backend, args)` only; the frozen empty
 * `deps` below satisfies the type, and `typed.test.ts` fails if one of them
 * declares a third or a rest parameter, uses `arguments`, or touches a `deps`
 * that throws on use. The backend this module is given is typed as those four
 * methods only (`MainTypedReadsBackend`).
 */
/** The four methods the typed reads call, and nothing else of the backend. */
export type MainTypedReadsBackend = Pick<
  NapiBackendLike,
  | "ftsSearch"
  | "codexSemanticSearch"
  | "eventsSemanticSearch"
  | "foreshadowListOpenForContext"
>;

export interface MainTypedReadsOptions extends MainReadHooks {
  readonly backend: MainTypedReadsBackend;
  /** The identity Main issued this turn; its `workspaceId` pins the semantic reads. */
  readonly identity: MainIssuedCallerIdentity;
}

const NO_DEPS: DispatchDeps = Object.freeze({
  backend: null,
  shell: Object.freeze({}),
}) as unknown as DispatchDeps;

const FTS_SCOPES: ReadonlySet<string> = new Set<FtsScope>([
  "codex",
  "scenes",
  "snippets",
]);

type AnyMethod = (...args: unknown[]) => unknown;

function bound(source: object, method: unknown): AnyMethod | undefined {
  return typeof method === "function"
    ? (method as AnyMethod).bind(source)
    : undefined;
}

function narrowBackend(source: MainTypedReadsBackend): MainTypedReadsBackend {
  const narrowed: Record<string, AnyMethod> = {};
  const fts = bound(source, source.ftsSearch);
  if (fts) narrowed.ftsSearch = fts;
  const codex = bound(source, source.codexSemanticSearch);
  if (codex) narrowed.codexSemanticSearch = codex;
  const events = bound(source, source.eventsSemanticSearch);
  if (events) narrowed.eventsSemanticSearch = events;
  const foreshadow = bound(source, source.foreshadowListOpenForContext);
  if (foreshadow) narrowed.foreshadowListOpenForContext = foreshadow;
  return Object.freeze(narrowed) as unknown as MainTypedReadsBackend;
}

export function createMainTypedReads(
  options: MainTypedReadsOptions,
): CoreNativeReads {
  const { identity } = options;
  // Copied at run time into an object that has the four methods and nothing
  // else: the Pick above is a type only, and the object the caller passes has
  // every method of the backend. A missing method stays missing (fail closed).
  const backend = narrowBackend(options.backend);
  // `run` is typed on the whole interface. Only the four methods above exist on
  // the object it gets, and the four commands below reach only those
  // (`typed.test.ts` and the static test hold that).
  const nativeBackend = backend as unknown as NapiBackendLike;

  const workspacePath = (command: string): string => {
    const id = identity?.workspaceId;
    if (typeof id !== "string" || id === "") {
      throw new MainReadError(
        "workspace",
        `${command}: the turn's identity has no workspace`,
        { command },
      );
    }
    return id;
  };
  const projectIdOf = (command: string, projectId: unknown): string => {
    try {
      assertCoreProjectId(projectId);
    } catch {
      throw new MainReadError("argument", `${command}: projectId is required`, {
        command,
      });
    }
    return projectId;
  };

  return {
    fts: async (args) => {
      const projectId = projectIdOf("fts_search", args.projectId);
      if (!FTS_SCOPES.has(args.scope)) {
        throw new MainReadError(
          "scope",
          `fts_search: scope ${String(args.scope)} is not read`,
          { command: "fts_search" },
        );
      }
      return runNativeRead(
        () =>
          NAPI_COMMANDS.fts_search.run(
            nativeBackend,
            {
              projectId,
              query: args.query,
              scope: args.scope,
              limit: args.limit,
            },
            NO_DEPS,
          ),
        {
          command: "fts_search",
          timeoutMs: MAIN_READ_CALLER_TIMEOUT_MS.fts_search,
          hooks: options,
        },
      );
    },
    codexSemantic: async (args) => {
      const projectId = projectIdOf("codex_semantic_search", args.projectId);
      const expectedWorkspacePath = workspacePath("codex_semantic_search");
      if (typeof backend.codexSemanticSearch !== "function") {
        throw new MainReadError(
          "backend-method",
          "codex_semantic_search: the backend has no such method",
          { command: "codex_semantic_search" },
        );
      }
      return runNativeRead(
        () =>
          NAPI_COMMANDS.codex_semantic_search.run(
            nativeBackend,
            {
              expectedWorkspacePath,
              projectId,
              query: args.query,
              limit: args.limit,
            },
            NO_DEPS,
          ),
        {
          command: "codex_semantic_search",
          timeoutMs: MAIN_READ_CALLER_TIMEOUT_MS.codex_semantic_search,
          hooks: options,
        },
      );
    },
    eventsSemantic: async (args) => {
      const projectId = projectIdOf("events_semantic_search", args.projectId);
      const expectedWorkspacePath = workspacePath("events_semantic_search");
      if (typeof backend.eventsSemanticSearch !== "function") {
        throw new MainReadError(
          "backend-method",
          "events_semantic_search: the backend has no such method",
          { command: "events_semantic_search" },
        );
      }
      return runNativeRead(
        () =>
          NAPI_COMMANDS.events_semantic_search.run(
            nativeBackend,
            {
              expectedWorkspacePath,
              projectId,
              query: args.query,
              limit: args.limit,
            },
            NO_DEPS,
          ),
        {
          command: "events_semantic_search",
          timeoutMs: MAIN_READ_CALLER_TIMEOUT_MS.events_semantic_search,
          hooks: options,
        },
      );
    },
    foreshadowOpen: async (args) => {
      const projectId = projectIdOf(
        "foreshadow_list_open_for_context",
        args.projectId,
      );
      return runNativeRead(
        () =>
          NAPI_COMMANDS.foreshadow_list_open_for_context.run(
            nativeBackend,
            { projectId },
            NO_DEPS,
          ),
        {
          command: "foreshadow_list_open_for_context",
          // The renderer gives this command no caller timeout either; no new
          // value is placed (DR-MP4-4). A cancel or a forced end drops the
          // result and the in-flight count bounds the wait.
          timeoutMs: null,
          hooks: options,
        },
      );
    },
  };
}
