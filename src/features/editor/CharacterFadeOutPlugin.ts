import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { resolveCoordsVertical } from "./cursorCoords";

export const characterFadeOutKey = new PluginKey<FadeOutState>(
  "characterFadeOut",
);

/** Fade duration must match the CSS transition for `.editor-fade-out-ghost`. */
const FADE_OUT_MS = 80;
const FADE_OUT_CLEANUP_BUFFER_MS = 60;

interface PendingFadeOut {
  char: string;
  newPos: number;
}

interface FadeOutState {
  pending: PendingFadeOut[];
}

const EMPTY_STATE: FadeOutState = { pending: [] };

type FadeOutMeta = { type: "consumed" };

/**
 * Renders a transient ghost glyph that fades out at the spot a single
 * character was deleted by Backspace or forward-Delete. Skips:
 * - programmatic deletes (chat insert undo, snippet replace, etc.)
 * - range deletes (Selection > 1 char) and cuts (Ctrl+X)
 *
 * Implementation: detect the single-char delete in `apply(tr)` via step
 * shape, queue a `PendingFadeOut`, then in `view.update` resolve the
 * screen coords with `coordsAtPos`, append a fixed-position glyph to
 * `document.body`, schedule its removal after the CSS animation, and
 * dispatch a "consumed" meta transaction to clear the queue.
 *
 * 縦書き (getVertical=true) では PM の coordsAtPos が矩形を flatten して
 * 列情報を失うため、スムースキャレットと同じ resolveCoordsVertical で
 * 挿入点を取り、ghost に writing-mode: vertical-rl を当てて縦向きに描く。
 */
export function createCharacterFadeOutPlugin(
  getFadeOut: () => boolean,
  getVertical: () => boolean,
): Plugin<FadeOutState> {
  return new Plugin<FadeOutState>({
    key: characterFadeOutKey,
    state: {
      init() {
        return EMPTY_STATE;
      },
      apply(tr, state, oldState, newState) {
        const meta = tr.getMeta(characterFadeOutKey) as FadeOutMeta | undefined;
        if (meta?.type === "consumed") {
          return EMPTY_STATE;
        }

        if (!tr.docChanged) return state;
        if (tr.getMeta("programmaticInsert")) return state;
        if (!getFadeOut()) return state;

        const sizeDiff = newState.doc.content.size - oldState.doc.content.size;
        if (sizeDiff !== -1) return state;

        // Single ReplaceStep with empty slice and exactly 1-position range.
        const step = tr.steps.find((s) => s instanceof ReplaceStep) as
          | ReplaceStep
          | undefined;
        if (!step) return state;
        if (step.slice.size !== 0) return state;
        if (step.to - step.from !== 1) return state;

        const char = oldState.doc.textBetween(step.from, step.to);
        if (!char || char.length !== 1) return state;

        return {
          pending: [...state.pending, { char, newPos: step.from }],
        };
      },
    },
    view(editorView) {
      return {
        update(view) {
          const s = characterFadeOutKey.getState(view.state);
          if (!s || s.pending.length === 0) return;

          const wrapper = view.dom;
          const computed = window.getComputedStyle(wrapper);
          const vertical = getVertical();

          for (const item of s.pending) {
            try {
              // 縦書きは bias=-1 (直前文字側) に anchor する。削除後の
              // reflow で動かないのは前方のテキストなので、削除された
              // 文字の元位置に最も近い安定点になる。null は flatten 版へ
              // フォールバック。
              const coords =
                (vertical
                  ? resolveCoordsVertical(view, item.newPos, -1)
                  : null) ?? view.coordsAtPos(item.newPos);
              const ghost = document.createElement("span");
              ghost.className = "editor-fade-out-ghost";
              ghost.textContent = item.char;
              ghost.style.position = "fixed";
              ghost.style.left = `${coords.left}px`;
              ghost.style.top = `${coords.top}px`;
              if (vertical) ghost.style.writingMode = "vertical-rl";
              ghost.style.fontFamily = computed.fontFamily;
              ghost.style.fontSize = computed.fontSize;
              ghost.style.lineHeight = computed.lineHeight;
              ghost.style.color = computed.color;
              document.body.appendChild(ghost);
              setTimeout(
                () => ghost.remove(),
                FADE_OUT_MS + FADE_OUT_CLEANUP_BUFFER_MS,
              );
            } catch {
              // coordsAtPos can throw at doc edges; silently skip.
            }
          }

          // Dispatch in microtask to avoid re-entrant dispatch warnings.
          queueMicrotask(() => {
            if (editorView.isDestroyed) return;
            const { tr } = editorView.state;
            tr.setMeta(characterFadeOutKey, {
              type: "consumed",
            } satisfies FadeOutMeta);
            editorView.dispatch(tr);
          });
        },
      };
    },
  });
}
