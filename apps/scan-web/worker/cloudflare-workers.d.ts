declare module "cloudflare:workers" {
  export interface WorkflowEvent<Params = unknown> {
    payload: Params;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(
      event: WorkflowEvent<Params>,
      step: WorkflowStep,
    ): Promise<unknown>;
  }
}
