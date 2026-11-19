/**
 * adapter の試験の共通部分（Mastra 移行 MP-2）。試験からだけ参照する。
 *
 * - `loadMastraForTest()`：Mastra を load する前に env の固定（`mastraEnv`）を当て、外向きの通信を記録して拒否する hook を入れる。
 *   `@mastra/*` は常にこの関数の中の動的 import で読む（固定の前に top-level で読まない）。
 * - `createRecordingAudit()`：audit の fake（呼ばれた順を記録する）。
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

import { createMastraEnvPin } from "../mastraEnv.js";
import type {
  AgentAuditCompletion,
  AgentAuditHandle,
  AgentAuditRequest,
  AgentAuditSink,
  AgentNativeAuditContext,
} from "./agentWire.js";

export interface NetworkRecord {
  readonly kind: string;
  readonly target: string;
  /** unix socket／loopback。vitest 自身の通信を落とさないために通す（外部は 0 を assert する）。 */
  readonly local: boolean;
}

export interface NetworkGuard {
  readonly records: NetworkRecord[];
  /** 外部（local でない）への接続の試み。 */
  external(): NetworkRecord[];
  restore(): void;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * 外向きの通信を横取りして記録し、local でないものは失敗させる（spike の hook-net と同じ方式）。
 * 対象：http／https の request／get、`fetch`、`net.connect`／`createConnection`／`Socket#connect`、`tls.connect`、dns の解決。
 * 接続 API の全面ではない（spike S3 の注記）。外部通信 0 の根拠は、これと env の固定の併用。
 */
export function installNetworkGuard(): NetworkGuard {
  const records: NetworkRecord[] = [];
  const restores: (() => void)[] = [];
  const patch = <T extends object, K extends keyof T & string>(
    target: T,
    key: K,
    replacement: T[K],
  ): void => {
    const original = target[key];
    target[key] = replacement;
    restores.push(() => {
      target[key] = original;
    });
  };
  const blocked = (what: string) =>
    Object.assign(new Error(`network guard: blocked ${what}`), {
      code: "ECONNREFUSED",
    });
  const hostOf = (value: unknown): string => {
    if (typeof value === "string") {
      try {
        return new URL(value).hostname;
      } catch {
        return value;
      }
    }
    if (value instanceof URL) return value.hostname;
    if (typeof value === "object" && value !== null) {
      const record = value as {
        hostname?: unknown;
        host?: unknown;
        path?: unknown;
      };
      if (
        typeof record.path === "string" &&
        record.hostname === undefined &&
        record.host === undefined
      ) {
        return "unix";
      }
      return String(record.hostname ?? record.host ?? "localhost");
    }
    return "localhost";
  };
  const isLocal = (host: string): boolean =>
    host === "unix" || LOOPBACK.has(host);
  const record = (kind: string, target: string): boolean => {
    const local = isLocal(target);
    records.push({ kind, target, local });
    return local;
  };

  for (const [name, module] of [
    ["http", http],
    ["https", https],
  ] as const) {
    for (const fn of ["request", "get"] as const) {
      const original = module[fn].bind(module) as (
        ...args: unknown[]
      ) => unknown;
      patch(module, fn, ((...args: unknown[]) => {
        if (!record(`${name}.${fn}`, hostOf(args[0])))
          throw blocked(`${name}.${fn}`);
        return original(...args);
      }) as (typeof module)[typeof fn]);
    }
  }
  const originalFetch = globalThis.fetch;
  patch(globalThis, "fetch", (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string" || input instanceof URL ? input : input.url;
    if (!record("fetch", hostOf(url))) throw blocked("fetch");
    return originalFetch(input, init);
  }) as typeof fetch);
  for (const fn of ["connect", "createConnection"] as const) {
    const original = net[fn] as (...args: unknown[]) => net.Socket;
    patch(net, fn, ((...args: unknown[]) => {
      // net.connect("<path>") の文字列は socket／named pipe の path（local）。数値は port。
      const first = args[0];
      const target =
        typeof first === "string"
          ? "unix"
          : typeof first === "number"
            ? String(args[1] ?? "localhost")
            : hostOf(first);
      if (!record(`net.${fn}`, target)) throw blocked(`net.${fn}`);
      return original(...args);
    }) as (typeof net)[typeof fn]);
  }
  const originalSocketConnect = net.Socket.prototype.connect as (
    ...args: unknown[]
  ) => net.Socket;
  patch(net.Socket.prototype, "connect", function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const target =
      typeof first === "string"
        ? "unix"
        : typeof first === "number"
          ? String(args[1] ?? "localhost")
          : hostOf(first);
    if (!record("net.Socket.connect", target)) {
      queueMicrotask(() => this.destroy(blocked("net.Socket.connect")));
      return this;
    }
    return originalSocketConnect.apply(this, args);
  } as typeof net.Socket.prototype.connect);
  patch(tls, "connect", ((...args: unknown[]) => {
    record("tls.connect", hostOf(args[0]));
    throw blocked("tls.connect");
  }) as typeof tls.connect);
  for (const fn of ["lookup", "resolve", "resolve4", "resolve6"] as const) {
    patch(dns, fn, ((host: string, ...rest: unknown[]) => {
      if (record(`dns.${fn}`, String(host))) {
        const original = dns[fn] as (...args: unknown[]) => unknown;
        return original.call(dns, host, ...rest);
      }
      const callback = rest.find((value) => typeof value === "function") as
        | ((error: Error) => void)
        | undefined;
      if (callback) queueMicrotask(() => callback(blocked(`dns.${fn}`)));
      return undefined;
    }) as (typeof dns)[typeof fn]);
  }
  syncBuiltinESMExports();

  return {
    records,
    external: () => records.filter((entry) => !entry.local),
    restore: () => {
      for (const restore of restores.splice(0).reverse()) restore();
      syncBuiltinESMExports();
    },
  };
}

export interface MastraTestKit {
  readonly Agent: typeof import("@mastra/core/agent").Agent;
  readonly createTool: typeof import("@mastra/core/tools").createTool;
  readonly jsonSchema: typeof import("ai").jsonSchema;
  readonly guard: NetworkGuard;
  /** 固定の前の env の写し（試験が「固定で除かれた」ことを確かめる用）。 */
  readonly originalEnv: NodeJS.ProcessEnv;
}

let kit: Promise<MastraTestKit> | undefined;

/** env を固定し、通信の hook を入れてから Mastra を読む。1 つの試験 file で 1 回だけ実行される。 */
export function loadMastraForTest(): Promise<MastraTestKit> {
  kit ??= (async () => {
    const pin = createMastraEnvPin();
    const originalEnv = pin.originalEnv();
    pin.apply();
    const guard = installNetworkGuard();
    const { Agent } = await import("@mastra/core/agent");
    const { createTool } = await import("@mastra/core/tools");
    const { jsonSchema } = await import("ai");
    return { Agent, createTool, jsonSchema, guard, originalEnv };
  })();
  return kit;
}

// ---- audit の fake ---------------------------------------------------------

export type RecordedAuditEvent =
  | { readonly type: "begin"; readonly request: AgentAuditRequest }
  | { readonly type: "dispatched"; readonly executionId: string }
  | {
      readonly type: "complete";
      readonly executionId: string;
      readonly completion: AgentAuditCompletion;
    }
  | {
      readonly type: "fail";
      readonly executionId: string;
      readonly error: unknown;
    };

export interface RecordingAudit extends AgentAuditSink {
  readonly events: RecordedAuditEvent[];
  count(type: RecordedAuditEvent["type"]): number;
}

/**
 * audit の fake。`executionId` は呼出し順に `exec-0`、`exec-1`…（renderer 側の試験の呼出しごとの値と揃える）。
 */
export function createRecordingAudit(
  context: Omit<AgentNativeAuditContext, "executionId"> & {
    chatMessageId?: string;
  },
): RecordingAudit {
  const events: RecordedAuditEvent[] = [];
  let next = 0;
  return {
    events,
    count: (type) => events.filter((event) => event.type === type).length,
    async begin(request) {
      events.push({ type: "begin", request });
      // key 順は renderer の `nativeAiAuditContext` と同じ。
      const handle: AgentAuditHandle = {
        auditContext: {
          expectedWorkspacePath: context.expectedWorkspacePath,
          projectId: context.projectId,
          operationId: context.operationId,
          executionId: `exec-${next++}`,
          parentExecutionId: context.parentExecutionId,
          pathId: context.pathId,
        },
        ...(context.chatMessageId
          ? { chatMessageId: context.chatMessageId }
          : {}),
      };
      return handle;
    },
    async dispatched(handle) {
      events.push({
        type: "dispatched",
        executionId: handle.auditContext.executionId,
      });
    },
    async complete(handle, completion) {
      events.push({
        type: "complete",
        executionId: handle.auditContext.executionId,
        completion,
      });
    },
    async fail(handle, error) {
      events.push({
        type: "fail",
        executionId: handle.auditContext.executionId,
        error,
      });
    },
  };
}
