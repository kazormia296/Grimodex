type CliApiModule = typeof import("./cliApi");
type CodexAppApiModule = typeof import("./codexAppApi");

export const cliApi: Pick<CliApiModule, "sendCliChatStream"> = {
  sendCliChatStream: async (...args) => {
    const { sendCliChatStream } = await import("./cliApi");
    return sendCliChatStream(...args);
  },
};

export const codexAppApi: Pick<
  CodexAppApiModule,
  | "abortCodexAppTurn"
  | "advanceCodexHistoryRevision"
  | "sendCodexAppTurn"
  | "setCodexSessionThreadName"
> = {
  abortCodexAppTurn: async (...args) => {
    const { abortCodexAppTurn } = await import("./codexAppApi");
    return abortCodexAppTurn(...args);
  },
  advanceCodexHistoryRevision: async (...args) => {
    const { advanceCodexHistoryRevision } = await import("./codexAppApi");
    return advanceCodexHistoryRevision(...args);
  },
  sendCodexAppTurn: async (...args) => {
    const { sendCodexAppTurn } = await import("./codexAppApi");
    return sendCodexAppTurn(...args);
  },
  setCodexSessionThreadName: async (...args) => {
    const { setCodexSessionThreadName } = await import("./codexAppApi");
    return setCodexSessionThreadName(...args);
  },
};

export const archiveCodexSessionThread: CodexAppApiModule["archiveCodexSessionThread"] =
  async (...args) => {
    const { archiveCodexSessionThread: archive } =
      await import("./codexAppApi");
    return archive(...args);
  };

export const detectCliBinary: CliApiModule["detectCliBinary"] = async (
  ...args
) => {
  const { detectCliBinary: detect } = await import("./cliApi");
  return detect(...args);
};

export const listCliModels: CliApiModule["listCliModels"] = async (...args) => {
  const { listCliModels: list } = await import("./cliApi");
  return list(...args);
};

export const listCodexAppModels: CodexAppApiModule["listCodexAppModels"] =
  async (...args) => {
    const { listCodexAppModels: list } = await import("./codexAppApi");
    return list(...args);
  };
