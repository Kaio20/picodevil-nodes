import { parseExpressionAt } from "acorn";
import { getLeafLocations } from "@strudel/mini";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { activeArgument, helpAtSelection, quoteValue, type ActiveArgument } from "./editor-assistance";
import {
  categoryColors, choiceValues, colorArguments, floatArguments, floatDefault, parametersFor, patternArguments,
  ratioArguments, textArguments,
} from "./editor-catalog";
import { colorCss, colorFromCss, colorHex, isFunctionalColor } from "./color-value";
import { choiceField } from "./editor-choice-field";
import { hasHexColorToken } from "./editor-hex-colors";
import { colorField } from "./node-color-input";
import { bindNumberDrag } from "./node-number-input";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

function stringLiteral(raw: string): { value: string; quote: string } | undefined {
  const quote = raw[0];
  if (quote !== "'" && quote !== '"') return;
  try {
    const node = parseExpressionAt(raw, 0, { ecmaVersion: 2022 });
    if (node.type === "Literal" && typeof node.value === "string" && node.end === raw.length) {
      return { value: node.value, quote };
    }
  } catch { /* The code is still being typed. */ }
}

const patternTools = [
  { label: "Rest", example: "~", hint: "Leave a gap", edit: (step: string) => step ? `${step} ~` : "~" },
  { label: "Group", example: "[a b]", hint: "Fit these steps into one slot", edit: (step: string) => `[${step}]` },
  { label: "Alternate", example: "<a b>", hint: "Pick the next step each cycle", edit: (step: string) => `<${step}>` },
  { label: "Together", example: "a,b", hint: "Play steps at the same time", edit: (step: string) => step.trim().split(/\s+/).join(",") + (step.trim().includes(" ") ? "" : ",") },
  { label: "Repeat", example: "a*2", hint: "Play a step twice", edit: (step: string) => /\s/.test(step) ? `[${step}]*2` : `${step}*2` },
];

function patternEditor(value: string, commit: (value: string) => void) {
  const panel = element("div", "pd-pattern-editor");
  const input = element("input", "pd-pattern-input");
  input.value = value;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Pattern steps");
  const steps = element("div", "pd-pattern-steps");
  const tools = element("div", "pd-pattern-tools");
  const hint = element("small", "pd-pattern-hint", "Spaces play steps in order. Select steps to group, alternate or repeat them.");
  const showSteps = () => {
    steps.replaceChildren();
    try {
      // Use the same parser as playback, so steps inside groups remain individually editable.
      const locations: [number, number][] = getLeafLocations(`"${input.value}"`);
      for (const [start, end] of locations.slice(0, 24)) {
        const from = start - 1, to = end - 1;
        if (from < 0 || to <= from) continue;
        const step = element("button", "pd-pattern-step", input.value.slice(from, to));
        step.type = "button";
        step.addEventListener("click", () => {
          input.focus();
          input.setSelectionRange(from, to);
        });
        steps.append(step);
      }
    } catch { /* Keep the input available while a pattern is incomplete. */ }
  };
  const write = () => { commit(input.value); showSteps(); };
  input.addEventListener("input", write);
  for (const tool of patternTools) {
    const button = element("button", "pd-pattern-tool", tool.label);
    button.type = "button";
    button.title = `${tool.hint} (${tool.example})`;
    button.addEventListener("click", () => {
      let from = input.selectionStart ?? input.value.length;
      let to = input.selectionEnd ?? from;
      if (from === to && tool.label !== "Rest") { from = 0; to = input.value.length; }
      const selected = input.value.slice(from, to);
      const insertion = tool.label === "Rest" && !selected && from > 0 && !/\s$/.test(input.value.slice(0, from))
        ? " ~" : tool.edit(selected);
      input.setRangeText(insertion, from, to, "select");
      input.focus();
      write();
    });
    tools.append(button);
  }
  panel.append(steps, tools, hint);
  showSteps();
  return { input, panel };
}

function textField(value: string, label: string, commit: (value: string) => void) {
  const input = element("input", "pd-value-field");
  input.value = value;
  input.setAttribute("aria-label", label);
  input.spellcheck = false;
  input.addEventListener("input", () => commit(input.value));
  return input;
}

function withLeadingZero(value: string) {
  return value.replace(/^([+-]?)\.(?=\d)/, (_, sign: string) => `${sign}0.`);
}

function numberField(source: string, value: number | undefined, label: string, ratio: boolean, commit: (value: string) => void) {
  const group = element("span", "pd-number-tools");
  const field = element("input", "pd-value-field pd-value-number");
  field.type = "number";
  field.step = "any";
  field.value = source ? withLeadingZero(source) : floatDefault;
  if (!field.value && value !== undefined) field.value = String(value);
  field.title = "Type a number or drag right/up to increase it";
  field.setAttribute("aria-label", label);
  field.addEventListener("focus", () => {
    if (field.value === floatDefault) field.select();
  });
  group.append(field);

  if (ratio) {
    const range = element("input", "pd-value-range");
    range.type = "range";
    range.min = field.min = "0";
    range.max = field.max = "1";
    range.step = "0.01";
    range.value = field.value;
    range.setAttribute("aria-label", `${label} slider`);
    let sliding = false;
    range.addEventListener("pointerdown", () => { sliding = true; });
    range.addEventListener("pointerup", () => { sliding = false; });
    range.addEventListener("pointercancel", () => { sliding = false; });
    range.addEventListener("input", () => {
      field.value = range.value;
      // Keep the native thumb mounted until a pointer gesture finishes.
      if (!sliding) commit(field.value);
    });
    range.addEventListener("change", () => commit(range.value));
    field.addEventListener("input", () => { range.value = field.value; });
    group.append(range);
  }
  field.addEventListener("input", () => {
    if (!field.validity.badInput) commit(withLeadingZero(field.value));
  });
  field.addEventListener("change", () => {
    if (!field.validity.badInput) field.value = withLeadingZero(field.value);
  });
  bindNumberDrag(field, ratio ? 0.01 : undefined, next => {
    if (Number.isFinite(next)) {
      const slider = group.querySelector<HTMLInputElement>(".pd-value-range");
      if (slider) slider.value = String(next);
      commit(String(next));
    }
  });
  return group;
}

class ArgumentInputWidget extends WidgetType {
  constructor(readonly field: HTMLElement) { super(); }
  toDOM() { return this.field; }
}

type Placement = "value" | "string-contents";

function numberLiteral(source: string): number | undefined {
  if (!/^[\d.+-]/.test(source)) return;
  try {
    const node = parseExpressionAt(source, 0, { ecmaVersion: 2022 });
    if (node.end !== source.length) return;
    const atom = node.type === "UnaryExpression" && /^[+-]$/.test(node.operator) ? node.argument : node;
    if (atom.type !== "Literal" || typeof atom.value !== "number" || !Number.isFinite(atom.value)) return;
    return node.type === "UnaryExpression" && node.operator === "-" ? -atom.value : atom.value;
  } catch { /* Incomplete numbers are edited in the source. */ }
}

function argumentKey(argument: ActiveArgument) {
  return `${(argument.entry?.name ?? argument.name).toLowerCase()}:${argument.index}`;
}

const typedFloat = EditorState.transactionFilter.of(transaction => {
  const { main, ranges } = transaction.newSelection;
  if (!transaction.docChanged || !transaction.isUserEvent("input.type") || ranges.length !== 1 || !main.empty) return transaction;
  const before = transaction.newDoc.sliceString(main.head - 1, main.head);
  if (!/[,(\d]/.test(before)) return transaction;
  const argument = activeArgument(transaction.state, main.head);
  if (!argument || !floatArguments.has(argumentKey(argument))) return transaction;
  const { from, value } = argument;

  if (!value && /[,(]/.test(before)) {
    return [transaction, {
      changes: { from, insert: floatDefault },
      selection: { anchor: from, head: from + floatDefault.length },
      sequential: true,
    }];
  }
  if (/^[+-]?\.\d/.test(value) && numberLiteral(value) !== undefined) {
    const decimal = from + value.indexOf(".");
    return [transaction, { changes: { from: decimal, insert: "0" }, sequential: true }];
  }
  return transaction;
});

// A separator confirms the selected default and continues in the same call.
const confirmFloat = Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
  if ((text !== "," && text !== ")") || view.state.sliceDoc(from, to) !== floatDefault) return false;
  const argument = activeArgument(view.state, from);
  if (!argument || argument.from !== from || argument.to !== to || !floatArguments.has(argumentKey(argument))) return false;
  const skipClose = text === ")" && view.state.sliceDoc(to, to + 1) === ")";
  view.dispatch({
    changes: skipClose ? undefined : { from: to, insert: text },
    selection: { anchor: to + 1 },
    userEvent: "input.type",
  });
  return true;
}));

export function argumentBar(parent: HTMLElement) {
  const bar = element("div", "pd-argument-bar");
  bar.setAttribute("aria-label", "Function and argument help");
  const help = element("div", "pd-signature-help");
  const signature = element("div", "pd-signature");
  const explanation = element("div", "pd-argument-description");
  const controls = element("div", "pd-argument-controls");
  help.append(signature, explanation);
  bar.append(help, controls);
  parent.append(bar);

  const plugin = ViewPlugin.fromClass(class {
    context: ActiveArgument | undefined;
    editedByControl = false;
    decorations: DecorationSet = Decoration.none;
    inlineControl: { widget: ArgumentInputWidget; placement: Placement } | undefined;
    constructor(readonly view: EditorView) { this.refresh(); }

    update(update: ViewUpdate) {
      const restoreControls = update.focusChanged && this.view.hasFocus && this.editedByControl;
      if (!update.docChanged && !update.selectionSet && !restoreControls) return;
      this.refresh(update.transactions.some(transaction => transaction.isUserEvent("input.argument")), restoreControls);
    }

    commit(value: string) {
      const current = this.context;
      if (!current || value === current.value) return;
      const { view } = this;
      const cursor = view.state.selection.main.head;
      const selection = cursor >= current.from && cursor <= current.to
        ? EditorSelection.cursor(current.from + Math.min(cursor - current.from, value.length))
        : undefined;
      const field = this.inlineControl?.widget.field;
      const active = field?.ownerDocument.activeElement;
      const input = active instanceof HTMLInputElement && field?.contains(active) ? active : undefined;
      const start = input?.selectionStart;
      const end = input?.selectionEnd;
      view.dispatch({ changes: { from: current.from, to: current.to, insert: value }, selection, userEvent: "input.argument" });
      // CodeMirror may reattach the widget when its replacement range changes.
      if (input?.isConnected && input.ownerDocument.activeElement !== input) {
        input.focus({ preventScroll: true });
        if (start != null && end != null) input.setSelectionRange(start, end);
      }
    }

    positionInlineWidget(context: ActiveArgument) {
      if (!this.inlineControl) return;
      const { state } = this.view;
      const selection = state.selection.main;
      if (state.selection.ranges.length > 1 || !selection.empty && (selection.from < context.from || selection.to > context.to)) {
        this.decorations = Decoration.none;
        return;
      }
      const { widget, placement } = this.inlineControl;
      const field = widget.field.querySelector("input");
      if (field) field.style.setProperty("--pd-input-width", `${Math.max(2, [...field.value].length + 0.25)}ch`);

      const lineEnd = state.doc.lineAt(context.to).to;
      // Keep hex swatches in the source visible while editing an argument.
      const beside = context.value.includes("\n") || placement === "string-contents" && hasHexColorToken(context.value);
      widget.field.classList.toggle("pd-inline-beside", beside);
      const quote = placement === "string-contents" && context.value ? 1 : 0;
      const from = beside ? lineEnd : context.from + quote;
      const to = beside ? lineEnd : context.to - quote;
      const decoration = from === to
        ? Decoration.widget({ widget, side: 1 })
        : Decoration.replace({ widget });
      this.decorations = Decoration.set([decoration.range(from, to)]);
    }

    showInlineControl(control: HTMLElement, context: ActiveArgument, placement: Placement) {
      const field = element("span", "pd-inline-control");
      field.append(control);
      this.inlineControl = { widget: new ArgumentInputWidget(field), placement };
      this.positionInlineWidget(context);
    }

    refresh(fromControl = false, force = false) {
      const subject = helpAtSelection(this.view.state);
      const context = subject && "index" in subject ? subject : undefined;
      const previous = this.context;
      this.context = context;
      const sameArgument = context && previous && context.from === previous.from &&
        context.index === previous.index && context.name === previous.name;
      if (fromControl && sameArgument) {
        this.editedByControl = true;
        this.positionInlineWidget(context);
        return;
      }
      if (!force && sameArgument && context.value === previous.value) {
        this.positionInlineWidget(context);
        return;
      }
      this.editedByControl = false;
      this.inlineControl = undefined;
      this.decorations = Decoration.none;
      controls.replaceChildren();
      signature.replaceChildren();
      bar.style.setProperty("--pd-argument-accent", subject?.entry ? categoryColors[subject.entry.category] : "var(--pd-muted)");
      if (!subject) {
        signature.textContent = "Function help";
        explanation.textContent = "Select a function, argument or signal in the code.";
        return;
      }

      const { name, method, entry } = subject;
      const params = entry ? parametersFor(entry, method) : [];
      const param = context ? params[context.index] ?? (params.at(-1)?.rest ? params.at(-1) : undefined) : undefined;
      const argumentLabel = context ? `Argument ${context.index + 1}` : undefined;
      signature.append(element("strong", "pd-function-name", `${method ? "." : ""}${name}`));
      if (!entry?.constant) {
        signature.append("(");
        for (const [i, item] of params.entries()) {
          if (i) signature.append(", ");
          signature.append(element("span", item === param ? "pd-current-parameter" : "",
            `${item.rest ? "..." : ""}${item.name}${item.optional ? "?" : ""}`));
        }
        if (!params.length && context?.value && argumentLabel) {
          signature.append(element("span", "pd-current-parameter", argumentLabel.toLowerCase()));
        }
        signature.append(")");
      }
      explanation.textContent = [entry?.summary, param?.description].filter(Boolean).join(" · ") ||
        argumentLabel || "No reference entry available.";
      if (!context) return;

      const { value, index } = context;
      const key = (entry?.name ?? name).toLowerCase();
      const slot = argumentKey(context);
      const label = `${name} ${param?.name ?? `argument ${index + 1}`}`;
      const commit = (source: string) => this.commit(source);
      const literal = stringLiteral(value);
      const number = numberLiteral(value);
      const choices = choiceValues[slot];
      const acceptsPattern = patternArguments.has(slot);
      const acceptsText = textArguments.has(slot);
      const quote = literal?.quote ?? (choices || acceptsPattern ? '"' : "'");
      const commitText = (next: string) => commit(quoteValue(next, quote));
      const supportsColor = index === 0 && colorArguments.has(key);
      const color = supportsColor && literal ? colorFromCss(literal.value) : undefined;
      // An unquoted expression stays editable as code. Literal controls never
      // coerce signals, pattern expressions or partially typed JavaScript.
      if (supportsColor && (color || !value)) {
        const field = colorField(color, label, next => {
          if (!next) return;
          const css = literal && isFunctionalColor(literal.value) ? colorCss(next) : colorHex(next);
          commit(quoteValue(css, literal?.quote ?? "'"));
        }, { isSet: true });
        controls.append(field);
      }
      if (choices && (!value || literal)) {
        const input = textField(literal?.value ?? "", label, commitText);
        this.showInlineControl(choiceField(input, label, choices, commitText), context, "string-contents");
      } else if (!color && (literal || !value && (acceptsPattern || acceptsText))) {
        if (acceptsPattern || literal?.quote === '"' || key === "color") {
          const { input, panel } = patternEditor(literal?.value ?? "", commitText);
          this.showInlineControl(input, context, "string-contents");
          controls.append(panel);
        } else {
          this.showInlineControl(textField(literal?.value ?? "", label, commitText), context, "string-contents");
        }
      } else if (number !== undefined || !value && floatArguments.has(slot)) {
        this.showInlineControl(numberField(value, number, label, ratioArguments.has(slot), commit), context, "value");
      }
    }
  }, { decorations: plugin => plugin.decorations });
  return [typedFloat, confirmFloat, plugin];
}
