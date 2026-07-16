import { handleRequest } from "./router";
import type { ScanEnv, WorkerExecutionContextLike } from "./env";
import { runRetentionCleanup } from "./retention";
export { ScanWorkflow } from "./workflow";

export { handleRequest };

const worker = {
  fetch(
    request: Request,
    env: ScanEnv,
    ctx: WorkerExecutionContextLike,
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  scheduled(
    _controller: { cron: string },
    env: ScanEnv,
    ctx: WorkerExecutionContextLike,
  ): void {
    ctx.waitUntil(runRetentionCleanup(env, ctx));
  },
};

export default worker;
