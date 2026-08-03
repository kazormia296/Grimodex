import { spawn } from "node:child_process";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function describeToolError(result) {
  const messages = Array.isArray(result?.content)
    ? result.content
        .filter(
          (item) =>
            item &&
            typeof item === "object" &&
            item.type === "text" &&
            typeof item.text === "string",
        )
        .map((item) => item.text.trim())
        .filter(Boolean)
    : [];
  return messages.length > 0 ? messages.join("\n") : "unknown tool error";
}

function createRpcError(error, stderr) {
  const code =
    error && typeof error === "object" && "code" in error
      ? ` (${String(error.code)})`
      : "";
  const message =
    error && typeof error === "object" && typeof error.message === "string"
      ? error.message
      : "unknown JSON-RPC error";
  const details =
    error && typeof error === "object" && "data" in error
      ? `: ${JSON.stringify(error.data)}`
      : "";
  const stderrDetails = stderr.trim() ? `\nMCP stderr:\n${stderr.trim()}` : "";
  return new Error(
    `MCP JSON-RPC error${code}: ${message}${details}${stderrDetails}`,
  );
}

function assertRpcResult(result, method) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`MCP ${method} returned an invalid result`);
  }
  return result;
}

export async function launchProductJourneyMcpClient({
  binaryPath,
  workspacePath,
  projectId,
  spawnProcess = spawn,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  onStderr,
}) {
  assertNonEmptyString(binaryPath, "binaryPath");
  assertNonEmptyString(workspacePath, "workspacePath");
  if (projectId !== undefined) {
    assertNonEmptyString(projectId, "projectId");
  }
  if (
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    !Number.isFinite(shutdownTimeoutMs) ||
    shutdownTimeoutMs <= 0
  ) {
    throw new TypeError("MCP timeouts must be positive finite numbers");
  }
  if (onStderr !== undefined && typeof onStderr !== "function") {
    throw new TypeError("onStderr must be a function");
  }

  const args = ["--workspace", workspacePath];
  if (projectId !== undefined) {
    args.push("--project", projectId);
  }
  const child = spawnProcess(binaryPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child?.stdin || !child.stdout || !child.stderr) {
    throw new Error("MCP process did not expose piped stdio");
  }

  let nextRequestId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let exited = false;
  let exitDescription = "";
  let closing = false;
  let fatalError;
  const pending = new Map();

  function stderrSuffix() {
    return stderrBuffer.trim() ? `\nMCP stderr:\n${stderrBuffer.trim()}` : "";
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  function fail(error) {
    if (fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    rejectPending(fatalError);
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail(new Error("MCP server emitted a non-object JSON-RPC message"));
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      return;
    }

    const request = pending.get(message.id);
    if (!request) {
      fail(
        new Error(
          `MCP server responded with an unknown request id: ${String(message.id)}`,
        ),
      );
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timeout);

    if (message.jsonrpc !== "2.0") {
      request.reject(
        new Error(
          `MCP ${request.method} returned an invalid JSON-RPC version${stderrSuffix()}`,
        ),
      );
      return;
    }
    if (Object.hasOwn(message, "error")) {
      request.reject(createRpcError(message.error, stderrBuffer));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      request.reject(
        new Error(
          `MCP ${request.method} response omitted both result and error${stderrSuffix()}`,
        ),
      );
      return;
    }
    request.resolve(message.result);
  }

  function consumeStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handleMessage(JSON.parse(trimmed));
    } catch (error) {
      fail(
        new Error(
          `MCP server emitted invalid JSON: ${
            error instanceof Error ? error.message : String(error)
          }${stderrSuffix()}`,
        ),
      );
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes("\n")) {
      const lineEnd = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, lineEnd);
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      consumeStdoutLine(line);
    }
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer.trim()) {
      consumeStdoutLine(stdoutBuffer);
    }
    stdoutBuffer = "";
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    onStderr?.(chunk);
  });

  child.stdin.on("error", (error) => {
    fail(
      new Error(
        `MCP stdin failed: ${
          error instanceof Error ? error.message : String(error)
        }${stderrSuffix()}`,
      ),
    );
  });
  child.on("error", (error) => {
    exitDescription = error.message;
    fail(new Error(`MCP process failed: ${error.message}${stderrSuffix()}`));
  });
  child.on("exit", (code, signal) => {
    exited = true;
    exitDescription =
      signal !== null && signal !== undefined
        ? `signal ${String(signal)}`
        : `exit code ${String(code)}`;
    if (!closing && pending.size > 0) {
      fail(
        new Error(
          `MCP process exited before completing requests (${exitDescription})${stderrSuffix()}`,
        ),
      );
    }
  });

  function writeMessage(message) {
    if (fatalError) throw fatalError;
    if (exited) {
      throw new Error(
        `Cannot write to exited MCP process (${exitDescription})${stderrSuffix()}`,
      );
    }
    if (closing) {
      throw new Error("Cannot write to a closing MCP process");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params = {}) {
    assertNonEmptyString(method, "method");
    if (fatalError) return Promise.reject(fatalError);
    if (exited) {
      return Promise.reject(
        new Error(
          `Cannot call ${method}; MCP process has exited (${exitDescription})${stderrSuffix()}`,
        ),
      );
    }
    if (closing) {
      return Promise.reject(
        new Error(`Cannot call ${method}; MCP client is closing`),
      );
    }

    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `MCP ${method} timed out after ${requestTimeoutMs}ms${stderrSuffix()}`,
          ),
        );
      }, requestTimeoutMs);
      timeout.unref?.();
      pending.set(id, { method, resolve, reject, timeout });
      try {
        writeMessage({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  function notify(method, params = {}) {
    assertNonEmptyString(method, "method");
    writeMessage({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  function waitForExit(timeoutMs) {
    if (exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.off("exit", handleExit);
        resolve(false);
      }, timeoutMs);
      const handleExit = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      child.once("exit", handleExit);
    });
  }

  async function close() {
    if (closing || exited) return;
    closing = true;
    rejectPending(new Error("MCP client closed before request completion"));

    let exitedGracefully = false;
    if (!child.stdin.destroyed) {
      const exitPromise = waitForExit(shutdownTimeoutMs);
      child.stdin.end();
      exitedGracefully = await exitPromise;
    }
    if (exited || exitedGracefully) return;

    const terminated = waitForExit(shutdownTimeoutMs);
    child.kill("SIGTERM");
    const exitedAfterTerminate = await terminated;
    if (exited || exitedAfterTerminate) return;

    const killed = waitForExit(shutdownTimeoutMs);
    child.kill("SIGKILL");
    const exitedAfterKill = await killed;
    if (!exited && !exitedAfterKill) {
      throw new Error(
        `MCP process did not exit after SIGKILL${stderrSuffix()}`,
      );
    }
  }

  try {
    const initializeResult = assertRpcResult(
      await request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "grimodex-product-journey",
          version: "1.0.0",
        },
      }),
      "initialize",
    );
    if (typeof initializeResult.protocolVersion !== "string") {
      throw new Error("MCP initialize result omitted protocolVersion");
    }
    notify("notifications/initialized");
  } catch (error) {
    await close();
    throw error;
  }

  return {
    async listTools() {
      return assertRpcResult(await request("tools/list"), "tools/list");
    },
    async callTool(name, argumentsValue = {}) {
      assertNonEmptyString(name, "tool name");
      if (
        !argumentsValue ||
        typeof argumentsValue !== "object" ||
        Array.isArray(argumentsValue)
      ) {
        throw new TypeError("tool arguments must be an object");
      }
      const result = assertRpcResult(
        await request("tools/call", {
          name,
          arguments: argumentsValue,
        }),
        "tools/call",
      );
      if (result.isError === true) {
        throw new Error(
          `MCP tool returned an error: ${describeToolError(result)}${stderrSuffix()}`,
        );
      }
      return result;
    },
    close,
  };
}
