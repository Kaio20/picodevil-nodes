import {
  acceptCompletion, autocompletion, completionKeymap, pickedCompletion, selectedCompletion,
  type Completion, type CompletionContext,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Prec, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { callName } from "./editor-assistance";
import { categoryColors, getReference, referenceCategories, signature } from "./editor-catalog";

interface Suggestion extends Completion {
  accent?: string;
  call?: boolean;
  hasArgs?: boolean;
}

function completionAboveCode(view: EditorView, option: Suggestion, from: number, to: number) {
  const alreadyOpen = /^\s*\(/.test(view.state.doc.sliceString(to, view.state.doc.lineAt(to).to));
  const parentheses = option.call && !alreadyOpen;
  const insert = option.label + (parentheses ? "()" : "");
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length - Number(parentheses && !!option.hasArgs) },
    annotations: pickedCompletion.of(option),
    userEvent: "input.complete",
  });
}

const options = referenceCategories.flatMap(({ name, entries }) => entries.flatMap(entry =>
  [entry.name, ...entry.aliases].map((label, index) => ({
    label,
    detail: signature(entry, label, false).slice(label.length),
    type: entry.constant ? "constant" : entry.isMethod ? "method" : "function",
    info: entry.summary,
    accent: categoryColors[name],
    boost: index ? -4 : name === "Sources" ? 5 : 0,
    call: !entry.constant,
    hasArgs: entry.params.length > 0,
    apply: completionAboveCode,
  } satisfies Suggestion)),
));

function suggestions(context: CompletionContext) {
  const match = context.matchBefore(/[\w$]+/);
  const from = match?.from ?? context.pos;
  const line = context.state.doc.lineAt(from);
  const method = /\.\s*$/.test(context.state.doc.sliceString(line.from, from)) ||
    (!line.text.slice(0, from - line.from).trim() &&
      line.number > 1 && /\.\s*$/.test(context.state.doc.line(line.number - 1).text));
  if (!match && !method && !context.explicit) return null;
  const tree = syntaxTree(context.state);
  for (let node = tree.resolveInner(context.pos, -1); node; ) {
    if (/String|Comment|RegExp/.test(node.name) || node.name === "TemplateString") return null;
    if (!node.parent || node.name === "Interpolation") break;
    node = node.parent;
  }
  const available = new Map<string, Suggestion>();
  for (const candidate of options) {
    if (method && !getReference(candidate.label, true)) continue;
    if (!available.has(candidate.label.toLowerCase())) available.set(candidate.label.toLowerCase(), candidate);
  }
  if (!method) {
    tree.iterate({
      to: from,
      enter(node) {
        if (node.name !== "VariableDefinition" || node.to > from) return;
        const label = context.state.doc.sliceString(node.from, node.to);
        available.set(label.toLowerCase(), { label, type: "variable", accent: "#ff82ce", boost: 6 });
      },
    });
  }
  return { from, options: [...available.values()], validFor: /[\w$]*/ };
}

class GhostText extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostText) { return this.text === other.text; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "pd-ghost-text";
    el.setAttribute("aria-hidden", "true");
    el.textContent = this.text;
    return el;
  }
}

const ghost = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  update({ view }: { view: EditorView }) {
    const option = selectedCompletion(view.state) as Suggestion | null;
    const { head, empty } = view.state.selection.main;
    const line = view.state.doc.lineAt(head);
    const typed = /[\w$]+$/.exec(line.text.slice(0, head - line.from))?.[0];
    const after = line.text.slice(head - line.from);
    this.decorations = Decoration.none;
    if (!view.hasFocus || !empty || !option || !typed || /^[\w$]/.test(after)) return;
    if (!option.label.toLowerCase().startsWith(typed.toLowerCase())) return;
    const text = option.label.slice(typed.length) + (option.call && !/^\s*\(/.test(after) ? "()" : "");
    if (text) this.decorations = Decoration.set([Decoration.widget({ widget: new GhostText(text), side: 1 }).range(head)]);
  }
}, { decorations: plugin => plugin.decorations });

const callColors = EditorView.decorations.compute(["doc"], state => {
  const decorations: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "CallExpression") return;
      const call = callName(node.node, state);
      const entry = call && getReference(call.name, call.method);
      if (!call || !entry) return;
      decorations.push(Decoration.mark({ attributes: { style: `color: ${categoryColors[entry.category]}` } }).range(call.from, call.to));
    },
  });
  return Decoration.set(decorations, true);
});

export const editorCompletion = [
  autocompletion({
    override: [suggestions],
    activateOnTypingDelay: 45,
    interactionDelay: 0,
    maxRenderedOptions: 8,
    defaultKeymap: false,
    addToOptions: [{
      position: 15,
      render(option: Suggestion) {
        const chip = document.createElement("span");
        chip.className = "pd-completion-dot";
        chip.style.background = option.accent ?? "currentColor";
        chip.setAttribute("aria-hidden", "true");
        return chip;
      },
    }],
  }),
  Prec.high(keymap.of([...completionKeymap, { key: "Tab", run: acceptCompletion }])),
  ghost,
  callColors,
];
