import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

// CM6 spinner widget — inserts an HTML triangle animation at cursor without modifying document text
export const addSpinnerEffect = StateEffect.define<number>();
export const removeSpinnerEffect = StateEffect.define<null>();

export class SpinnerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "augment-spinner";
    for (const cls of ["augment-dot-red", "augment-dot-green", "augment-dot-blue"]) {
      const dot = document.createElement("span");
      dot.className = "augment-spinner-dot " + cls;
      wrap.appendChild(dot);
    }
    return wrap;
  }
  ignoreEvent(): boolean { return true; }
}

export const spinnerField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addSpinnerEffect)) {
        decos = decos.update({ add: [Decoration.widget({ widget: new SpinnerWidget(), side: -1 }).range(e.value)] });
      } else if (e.is(removeSpinnerEffect)) {
        decos = Decoration.none;
      }
    }
    // Detect document deletions near the spinner position — treat as cancel.
    if (decos !== Decoration.none && tr.docChanged) {
      let spinnerPos = -1;
      const cursor = decos.iter();
      if (cursor.value) spinnerPos = cursor.from;
      if (spinnerPos >= 0) {
        let deleted = false;
        tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
          // Only cancel on deletions (removed > inserted) that touch the spinner position.
          // Insertions (Enter, typing) have toA === fromA — ignore those.
          const removedLen = toA - fromA;
          const insertedLen = toB - fromB;
          if (removedLen > 0 && insertedLen < removedLen && toA >= spinnerPos && fromA <= spinnerPos) deleted = true;
        });
        if (deleted) {
          // Schedule cancel effect on the next microtask to avoid dispatching during update.
          Promise.resolve().then(() => {
            try {
              // Find the EditorView from the transaction — CM6 doesn't expose it directly
              // on the transaction, so we look for the active generation's cmView.
              (globalThis as any).__augmentCancelGeneration?.();
            } catch { /* ignore */ }
          });
        }
      }
    }
    return decos;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Persistent agent status widget (skill invocation) ──
export const addAgentWidgetEffect = StateEffect.define<{ pos: number; name: string }>();
export const removeAgentWidgetEffect = StateEffect.define<null>();

export class AgentWidget extends WidgetType {
  constructor(private name: string) { super(); }
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "augment-agent-widget";
    const spinner = document.createElement("span");
    spinner.className = "augment-spinner";
    for (const cls of ["augment-dot-red", "augment-dot-green", "augment-dot-blue"]) {
      const dot = document.createElement("span");
      dot.className = "augment-spinner-dot " + cls;
      spinner.appendChild(dot);
    }
    wrap.appendChild(spinner);
    wrap.appendChild(document.createTextNode("\u00a0" + this.name));
    return wrap;
  }
  ignoreEvent(): boolean { return true; }
}

export const agentWidgetField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addAgentWidgetEffect)) {
        decos = decos.update({
          add: [Decoration.widget({ widget: new AgentWidget(e.value.name), side: 1 }).range(e.value.pos)],
        });
      } else if (e.is(removeAgentWidgetEffect)) {
        decos = Decoration.none;
      }
    }
    return decos;
  },
  provide: f => EditorView.decorations.from(f),
});
