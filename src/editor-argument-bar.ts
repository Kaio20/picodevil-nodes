import { parseExpressionAt } from "acorn";
import { getLeafLocations } from "@strudel/mini";
import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { activeArgument, type ActiveArgument } from "./editor-assistance";
import { categoryColors, choiceValues, colorArguments, parametersFor, ratioArguments } from "./editor-catalog";
import { colorCss, colorFromCss, colorHex, isFunctionalColor } from "./color-value";
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

function quoteValue(value: string, quote: string) {
  const json = JSON.stringify(value);
  if (quote === '"') return json;
  return "'" + json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
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
  panel.append(input, steps, tools, hint);
  showSteps();
  return panel;
}

function textField(value: string, label: string, commit: (value: string) => void) {
  const input = element("input", "pd-value-field");
  input.value = value;
  input.setAttribute("aria-label", label);
  input.spellcheck = false;
  input.addEventListener("input", () => commit(input.value));
  return input;
}

function numberField(value: number | undefined, label: string, ratio: boolean, commit: (value: string) => void) {
  const group = element("div", "pd-number-tools");
  const field = element("input", "pd-value-field pd-value-number");
  field.type = "number";
  field.step = "any";
  field.value = value === undefined ? "" : String(value);
  field.title = "Type a number or drag right/up to increase it";
  field.setAttribute("aria-label", label);
  group.append(field);

  if (ratio) {
    const range = element("input", "pd-value-range");
    range.type = "range";
    range.min = field.min = "0";
    range.max = field.max = "1";
    range.step = "0.01";
    range.value = field.value || "0.5";
    range.setAttribute("aria-label", `${label} slider`);
    range.addEventListener("input", () => { field.value = range.value; commit(field.value); });
    field.addEventListener("input", () => { range.value = field.value; });
    group.append(range);
  }
  field.addEventListener("input", () => {
    if (!field.validity.badInput) commit(field.value);
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

function choiceField(value: string, label: string, choices: readonly string[], commit: (value: string) => void) {
  const group = element("div", "pd-choice-tools");
  const input = textField(value, label, commit);
  const select = element("select", "pd-value-field pd-choice-menu");
  select.setAttribute("aria-label", `${label} options`);
  const placeholder = new Option("Choose…", "");
  placeholder.disabled = true;
  select.add(placeholder);
  for (const choice of choices) select.add(new Option(choice, choice));
  select.value = choices.includes(value) ? value : "";
  select.addEventListener("change", () => { input.value = select.value; commit(input.value); });
  input.addEventListener("input", () => { select.value = choices.includes(input.value) ? input.value : ""; });
  group.append(input, select);
  return group;
}

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

  return ViewPlugin.fromClass(class {
    context: ActiveArgument | undefined;
    editedByControl = false;
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
      view.dispatch({ changes: { from: current.from, to: current.to, insert: value }, selection, userEvent: "input.argument" });
    }

    refresh(fromControl = false, force = false) {
      const context = activeArgument(this.view.state);
      const previous = this.context;
      this.context = context;
      const sameArgument = context && previous && context.from === previous.from &&
        context.index === previous.index && context.name === previous.name;
      if (fromControl && sameArgument) {
        this.editedByControl = true;
        return;
      }
      if (!force && sameArgument && context.value === previous.value) return;
      this.editedByControl = false;
      controls.replaceChildren();
      signature.replaceChildren();
      bar.style.setProperty("--pd-argument-accent", context?.entry ? categoryColors[context.entry.category] : "var(--pd-muted)");
      if (!context) {
        signature.textContent = "Function help";
        explanation.textContent = "Place the cursor inside parentheses to see the arguments.";
        return;
      }

      const { value, name, method, entry, index } = context;
      const params = entry ? parametersFor(entry, method) : [];
      const param = params[index] ?? (params.at(-1)?.rest ? params.at(-1) : undefined);
      signature.append(element("strong", "pd-function-name", `${method ? "." : ""}${name}`), "(");
      for (const [i, item] of params.entries()) {
        if (i) signature.append(", ");
        signature.append(element("span", item === param ? "pd-current-parameter" : "",
          `${item.rest ? "..." : ""}${item.name}${item.optional ? "?" : ""}`));
      }
      if (!params.length && value) signature.append(element("span", "pd-current-parameter", `argument ${index + 1}`));
      signature.append(")");
      explanation.textContent = [entry?.summary, param?.description].filter(Boolean).join(" · ") ||
        `Argument ${index + 1}`;

      const key = (entry?.name ?? name).toLowerCase();
      const label = `${name} ${param?.name ?? `argument ${index + 1}`}`;
      const commit = (source: string) => this.commit(source);
      const literal = stringLiteral(value);
      const number = numberLiteral(value);
      const choices = index === 0 ? choiceValues[key] : undefined;
      const supportsColor = index === 0 && colorArguments.has(key);
      const color = supportsColor && literal ? colorFromCss(literal.value) : undefined;
      // An unquoted expression stays editable as code. Literal controls never
      // coerce signals, pattern expressions or partially typed JavaScript.
      if (supportsColor && (color || !value)) {
        const field = colorField(color, label, next => {
          if (!next) return;
          const css = literal && isFunctionalColor(literal.value) ? colorCss(next) : colorHex(next);
          commit(quoteValue(css, literal?.quote ?? "'"));
        }, false, true);
        controls.append(field);
      }
      if (choices && (!value || literal)) {
        controls.append(choiceField(literal?.value ?? "", label, choices, next => commit(quoteValue(next, literal?.quote ?? '"'))));
      } else if (!choices && literal && (literal.quote === '"' || key === "mini" || key === "color") && !color) {
        controls.append(patternEditor(literal.value, next => commit(quoteValue(next, literal.quote))));
      } else if (literal && !color) {
        controls.append(textField(literal.value, label, next => commit(quoteValue(next, literal.quote))));
      } else if (number !== undefined || !value && ratioArguments.has(`${key}:${index}`)) {
        controls.append(numberField(number, label, ratioArguments.has(`${key}:${index}`), commit));
      }
    }
  });
}
