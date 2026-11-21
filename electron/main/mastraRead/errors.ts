import type { ReadSqlRefusalCode } from "../../shared/mastraRead/sql.js";

/**
 * Why Electron main's read port refused or failed a read (MP-4b). `refused`
 * codes are raised BEFORE anything is sent to Native; `result-*` codes after
 * Native answered with something the port will not use; `timeout` when the
 * caller gave up waiting (Native is not stopped).
 */
export type MainReadErrorCode =
  | ReadSqlRefusalCode
  | "method"
  | "params"
  | "identity"
  | "argument"
  | "scope"
  | "workspace"
  | "backend-method"
  | "timeout"
  | "result-shape"
  | "result-marker"
  | "result-key";

export class MainReadError extends Error {
  readonly code: MainReadErrorCode;
  /** The Native command or method involved, when one was. */
  readonly command: string | null;
  /** True only when the code is one raised before the send. */
  readonly beforeSend: boolean;

  constructor(
    code: MainReadErrorCode,
    message: string,
    options: { command?: string } = {},
  ) {
    super(message);
    this.name = "MainReadError";
    this.code = code;
    this.command = options.command ?? null;
    this.beforeSend = !(
      code === "timeout" ||
      code === "result-shape" ||
      code === "result-marker" ||
      code === "result-key"
    );
  }
}
