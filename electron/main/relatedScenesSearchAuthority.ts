import { randomUUID } from "node:crypto";

const RELATED_SCENES_COMMANDS = new Set([
  "related_scenes_begin",
  "related_scenes_continue",
  "related_scenes_release",
  "nir1_evidence_qualify",
]);

export interface RelatedScenesSender {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", callback: () => void): unknown;
}

interface AuthorityOptions {
  readonly releaseOwner: (ownerKey: string) => Promise<unknown> | unknown;
  readonly onReleaseFailure?: (error: unknown) => void;
}

/** Sender identity is the actual WebContents object; numeric IDs and renderer
 * payload fields cannot create or transfer an existing operation's owner. */
export function createRelatedScenesSearchAuthority(options: AuthorityOptions) {
  const owners = new WeakMap<RelatedScenesSender, string>();
  return {
    bind(
      command: string,
      args: Record<string, unknown>,
      sender: RelatedScenesSender,
    ): Record<string, unknown> {
      if (!RELATED_SCENES_COMMANDS.has(command)) return args;
      if (sender.isDestroyed()) {
        throw new Error("RELATED_SCENES_SENDER_UNAVAILABLE");
      }
      let ownerKey = owners.get(sender);
      if (!ownerKey) {
        ownerKey = `related-scenes-owner:${randomUUID()}`;
        owners.set(sender, ownerKey);
        const capturedOwner = ownerKey;
        sender.once("destroyed", () => {
          owners.delete(sender);
          try {
            Promise.resolve(options.releaseOwner(capturedOwner)).catch(
              (error: unknown) => options.onReleaseFailure?.(error),
            );
          } catch (error) {
            options.onReleaseFailure?.(error);
          }
        });
      }
      return { ...args, ownerKey };
    },
  };
}
