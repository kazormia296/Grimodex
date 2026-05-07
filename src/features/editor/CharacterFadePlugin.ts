import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReplaceStep, ReplaceAroundStep } from "@tiptap/pm/transform";

export const characterFadeKey = new PluginKey<DecorationSet>("characterFade");

/** Fade duration must match the CSS transition for `.editor-fade-in`. */
const FADE_IN_MS = 120;
/** Extra slack so the decoration outlives the CSS transition. */
const FADE_CLEANUP_BUFFER_MS = 60;

interface FadeDecoSpec {
  expireAt: number;
}

interface CleanupMeta {
  type: "cleanup";
  now: number;
}

/**
 * Adds a temporary `editor-fade-in` class to ranges of text inserted by the
 * user (typing or IME composition). Skips programmatic inserts (chat insert,
 * snippet drop, paste, inline-AI accept) so animation only reacts to manual
 * input.
 *
 * The plugin keeps a DecorationSet of pending fades; each entry carries an
 * `expireAt` timestamp. A view-level timer dispatches a cleanup meta
 * transaction once all current entries should be expired, removing the
 * decorations and letting the editor return to a quiet state.
 */
export function createCharacterFadePlugin(
  getFadeIn: () => boolean,
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: characterFadeKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, decos) {
        let next = decos.map(tr.mapping, tr.doc);

        const meta = tr.getMeta(characterFadeKey) as CleanupMeta | undefined;
        if (meta?.type === "cleanup") {
          const expired = next
            .find()
            .filter((d) => (d.spec as FadeDecoSpec).expireAt <= meta.now);
          if (expired.length > 0) {
            next = next.remove(expired);
          }
        }

        if (!tr.docChanged) return next;
        if (tr.getMeta("programmaticInsert")) return next;
        if (!getFadeIn()) return next;

        const expireAt = Date.now() + FADE_IN_MS + FADE_CLEANUP_BUFFER_MS;
        const added: Decoration[] = [];

        for (const step of tr.steps) {
          if (
            !(step instanceof ReplaceStep) &&
            !(step instanceof ReplaceAroundStep)
          ) {
            continue;
          }
          const slice = step.slice;
          if (slice.size === 0) continue;

          // Map the inserted range through subsequent steps in this tr so
          // the decoration aligns with the final document.
          const stepIndex = tr.steps.indexOf(step);
          const mapping = tr.mapping.slice(stepIndex);
          const from = mapping.map(step.from);
          const to = mapping.map(step.from + slice.size);
          if (from < to) {
            added.push(
              Decoration.inline(from, to, { class: "editor-fade-in" }, {
                expireAt,
              } satisfies FadeDecoSpec),
            );
          }
        }

        if (added.length > 0) {
          next = next.add(tr.doc, added);
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        return characterFadeKey.getState(state) ?? DecorationSet.empty;
      },
    },
    view(editorView) {
      let timer: ReturnType<typeof setTimeout> | null = null;

      function scheduleCleanup() {
        if (timer !== null) return;
        const decos = characterFadeKey.getState(editorView.state);
        if (!decos) return;
        const list = decos.find();
        if (list.length === 0) return;
        const maxExpire = Math.max(
          ...list.map((d) => (d.spec as FadeDecoSpec).expireAt),
        );
        const wait = Math.max(20, maxExpire - Date.now());
        timer = setTimeout(() => {
          timer = null;
          if (editorView.isDestroyed) return;
          const { tr } = editorView.state;
          tr.setMeta(characterFadeKey, {
            type: "cleanup",
            now: Date.now(),
          } satisfies CleanupMeta);
          editorView.dispatch(tr);
          scheduleCleanup();
        }, wait);
      }

      return {
        update() {
          scheduleCleanup();
        },
        destroy() {
          if (timer !== null) clearTimeout(timer);
        },
      };
    },
  });
}
