import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { colorHex, parseHexColor, type ColorValue } from "./color-value";
import { colorField } from "./node-color-input";

class HexColorWidget extends WidgetType {
  constructor(
    readonly hex: string,
    readonly from: number,
    readonly color: ColorValue | undefined,
    readonly quoted: boolean,
  ) { super(); }

  eq(other: HexColorWidget) {
    return this.hex === other.hex && this.from === other.from && this.quoted === other.quoted;
  }

  toDOM(view: EditorView) {
    let quoted = this.quoted;
    const field = colorField(this.color, `Edit color ${this.hex}`, color => {
      if (!color || !view.contentDOM.contains(field) || view.state.readOnly) return;
      const to = view.posAtDOM(field);
      const previous = field.dataset.hexColor!;
      const from = to - previous.length;
      if (from < 0) return;
      if (view.state.doc.sliceString(from, to) !== previous) return;

      const hex = colorHex(color);
      const insert = quoted ? hex : `"${hex}"`;
      field.dataset.hexColor = hex;
      field.dataset.hexFrom = String(quoted ? from : from + 1);
      field.dataset.hexQuoted = "true";
      quoted = true;
      field.querySelector(".nd-color-swatch")?.setAttribute("aria-label", `Edit color ${hex}`);
      field.querySelector(".nd-color-popover")?.setAttribute("aria-label", `Edit color ${hex} picker`);
      view.dispatch({ changes: { from, to, insert }, userEvent: "input.color" });
    }, { hexDraft: this.color ? undefined : this.hex });
    field.classList.add("pd-hex-color");
    field.dataset.hexColor = this.hex;
    field.dataset.hexFrom = String(this.from);
    field.dataset.hexQuoted = String(this.quoted);
    return field;
  }

  updateDOM(dom: HTMLElement) {
    // Keep the open picker mounted during its own edits, including when the
    // new color is identical to a neighboring step.
    return dom.dataset.hexColor === this.hex &&
      dom.dataset.hexFrom === String(this.from) &&
      dom.dataset.hexQuoted === String(this.quoted);
  }
}

// Include an unfinished color, starting with a bare #.
const hexTokens = /#[\da-f]{0,8}(?![\w$])/gi;

function atPatternStep(before: string, after: string) {
  return (!before || /[\s"'`<\[({,|]/.test(before)) &&
    (!after || /[\s"'`>\])},|:?!*\/@%]/.test(after));
}

export function hasHexColorToken(source: string) {
  for (const match of source.matchAll(hexTokens)) {
    if (atPatternStep(source.charAt(match.index - 1), source.charAt(match.index + match[0].length))) return true;
  }
  return false;
}

const nonColorNodes = new Set(["LineComment", "BlockComment", "RegExp", "Hashbang", "PrivatePropertyDefinition"]);

const colors = new MatchDecorator({
  regexp: hexTokens,
  decorate(add, from, to, [hex], view) {
    const { state } = view;
    const tree = syntaxTree(state);
    const node = tree.resolveInner(from, 1);
    if (nonColorNodes.has(node.name)) return;
    // Bare hex text can parse as a private name with a missing `in` expression.
    if (node.name === "PrivatePropertyName" && !node.nextSibling?.type.isError) return;
    const quoted = node.name === "String" ||
      (node.name === "TemplateString" && tree.resolveInner(from, -1).name !== "InterpolationStart");
    const { doc } = state;
    if (quoted && !atPatternStep(doc.sliceString(Math.max(0, from - 1), from), doc.sliceString(to, to + 1))) return;
    const color = parseHexColor(hex);
    add(to, to, Decoration.widget({ widget: new HexColorWidget(hex, from, color, quoted), side: -1 }));
  },
});

export const hexColorWidgets = ViewPlugin.fromClass(class {
  decorations;

  constructor(view: EditorView) {
    this.decorations = colors.createDeco(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = colors.createDeco(update.view);
    }
  }
}, { decorations: plugin => plugin.decorations });
