import * as Blockly from "blockly";
import { effects, signalMethods, signals, sources } from "./block-code";
import { trackPointerDrag } from "./number-drag";

export const blockPalette = {
  Sources: "#5ba8ff", Signals: "#20b562", Expressions: "#beeb71", Playback: "#f68f37",
  Layout: "#ffe737", Image: "#25e2cd", Text: "#a675fe", Variables: "#ff82ce", Output: "#e03c28",
};
type Category = keyof typeof blockPalette;

function tint(color: string, amount: number): string {
  return `#${color.slice(1).match(/../g)!.map((channel, index) => {
    const base = [24, 25, 27][index];
    return Math.round(base + (Number.parseInt(channel, 16) - base) * amount).toString(16).padStart(2, "0");
  }).join("")}`;
}

export const blockTheme = Blockly.Theme.defineTheme("picodevil", {
  name: "picodevil",
  blockStyles: Object.fromEntries(Object.entries(blockPalette).map(([name, color]) => [name, {
    colourPrimary: tint(color, 0.085), colourSecondary: tint(color, 0.17), colourTertiary: tint(color, 0.4),
  }])),
  componentStyles: {
    workspaceBackgroundColour: "#191a1c",
    scrollbarColour: "#8a8a8f", scrollbarOpacity: 0.4, insertionMarkerColour: "#ffffff", insertionMarkerOpacity: 0.33,
  },
  fontStyle: { family: '"IBM Plex Mono", monospace', size: 11, weight: "normal" },
});

class ScrubNumber extends Blockly.FieldNumber {
  override initView(): void {
    super.initView();
    this.getSvgRoot()?.classList.add("bd-scrubbable");
  }

  protected override onMouseDown_(start: PointerEvent): void {
    const block = this.getSourceBlock();
    if (start.button !== 0 || !start.isPrimary || !block?.isEditable() || block.isInFlyout) {
      super.onMouseDown_(start);
      return;
    }
    start.stopPropagation();
    const initial = Number(this.getValue());
    const previousGroup = Blockly.Events.getGroup();
    let dragging = false;
    const root = this.getSvgRoot();
    trackPointerDrag(start, move => {
      const dx = move.clientX - start.clientX;
      const dy = start.clientY - move.clientY;
      const distance = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
      if (!dragging) {
        if (Math.abs(distance) < 5) return;
        dragging = true;
        if (!previousGroup) Blockly.Events.setGroup(true);
        root?.classList.add("bd-scrubbing");
      }
      const step = block.type === "pd_mini_repeat" ? 0.25 : 0.05;
      this.setValue(Number((initial + Math.trunc(distance / 5) * step).toPrecision(12)));
    }, end => {
      if (dragging) {
        root?.classList.remove("bd-scrubbing");
        if (!end) this.setValue(initial);
        Blockly.Events.setGroup(previousGroup);
      } else if (end && this.getSourceBlock()) {
        this.showEditor_(end);
      }
    });
  }
}

const value = (name: string, check: string) => ({ type: "input_value", name, check });
const statement = (name: string, check: string) => ({ type: "input_statement", name, check });
const dropdown = (name: string, options: readonly (readonly [string, string])[]) => ({ type: "field_dropdown", name, options });
const text = (name: string, value: string) => ({ type: "field_input", name, text: value });
const rhythmOutputs = ["Mini", "Value"];

Blockly.Extensions.register("pd_layer_name", function (this: Blockly.Block) {
  const mode = this.getField("MODE")!;
  const name = this.getField("NAME")!;
  const showName = (value: string) => {
    name.setVisible(value !== "output" && value !== "single");
    return value;
  };
  showName(String(mode.getValue()));
  mode.setValidator(showName);
});

const baseBlocks = [
  {
    type: "pd_layer", message0: "%1 %2", args0: [dropdown("MODE", [
      ["Output layer", "output"], ["Named layer", "label"], ["Hidden layer", "hidden"], ["Solo layer", "solo"],
      ["Muted layer", "mute"], ["Muted layer (suffix)", "muteSuffix"], ["Single pattern", "single"],
    ]), text("NAME", "layer")], message1: "%1", args1: [statement("STEPS", "Source")],
    previousStatement: "Program", nextStatement: "Program", style: "Output", extensions: ["pd_layer_name"],
    tooltip: "Render a pattern. Hidden layers can be reused by name and stay off the main canvas.",
  },
  {
    type: "pd_tempo", message0: "%1 %2", args0: [dropdown("MODE", [["Cycles per minute", "setCpm"], ["Cycles per second", "setCps"]]), value("VALUE", "Value")],
    previousStatement: "Program", nextStatement: "Program", style: "Playback",
  },
  {
    type: "pd_source", message0: "%1 %2", args0: [dropdown("SOURCE", sources), value("VALUE", "Value")],
    previousStatement: "Source", nextStatement: "Transform", style: "Sources", inputsInline: true,
  },
  { type: "pd_pattern", message0: "Pattern %1", args0: [statement("STEPS", "Source")], output: "Pattern", style: "Sources" },
  {
    type: "pd_transform", message0: "%1 %2", args0: [dropdown("FORM", [["Transform", "factory"], ["Transform chain", "chain"]]), statement("STEPS", "Transform")],
    output: "Transform", style: "Playback",
  },
  { type: "pd_text", message0: "Text %1", args0: [text("VALUE", "text")], output: "Value", style: "Text" },
  { type: "pd_mini_text", message0: "Mini %1", args0: [text("VALUE", "red blue")], output: rhythmOutputs, style: "Expressions" },
  { type: "pd_mini_atom", message0: "Step %1", args0: [text("VALUE", "red")], output: rhythmOutputs, style: "Expressions" },
  { type: "pd_mini_pause", message0: "Rest", output: rhythmOutputs, style: "Expressions" },
  {
    type: "pd_mini_join", message0: "%1 %2 %3", args0: [dropdown("MODE", [["Sequence", "sequence"], ["Parallel", "parallel"]]), value("LEFT", "Mini"), value("RIGHT", "Mini")],
    output: rhythmOutputs, style: "Expressions", inputsInline: true,
  },
  {
    type: "pd_mini_group", message0: "%1 %2", args0: [dropdown("MODE", [["Group", "group"], ["Alternate", "alternate"]]), value("PATTERN", "Mini")],
    output: rhythmOutputs, style: "Expressions",
  },
  {
    type: "pd_signal", message0: "%1", args0: [dropdown("NAME", signals.map(name => [name, name]))], output: "Value", style: "Signals",
  },
  {
    type: "pd_signal_rate", message0: "%1 %2 by %3", args0: [value("SIGNAL", "Value"), dropdown("NAME", signalMethods.filter(name => name !== "range").map(name => [name, name])), value("AMOUNT", "Value")],
    output: "Value", style: "Signals", inputsInline: true,
  },
  {
    type: "pd_signal_range", message0: "%1 range %2 to %3", args0: [value("SIGNAL", "Value"), value("MIN", "Value"), value("MAX", "Value")],
    output: "Value", style: "Signals", inputsInline: true,
  },
];

Blockly.defineBlocksWithJsonArray([...baseBlocks, ...effects.map(effect => ({
  type: `pd_fx_${effect.id}`,
  message0: [effect.label, ...effect.args.map((_, index) => `%${index + 1}`)].join(" "),
  args0: effect.args.map((arg, index) => value(`ARG${index}`, arg)),
  previousStatement: "Transform", nextStatement: "Transform", style: effect.category,
  inputsInline: true,
}))]);

Blockly.Blocks.pd_number = {
  init(this: Blockly.Block) {
    this.appendDummyInput().appendField(new ScrubNumber(1), "VALUE");
    this.setOutput(true, "Value");
    this.setStyle("Expressions");
    this.setTooltip("Drag to change the number, or click it to type a value.");
  },
};
Blockly.Blocks.pd_mini_repeat = {
  init(this: Blockly.Block) {
    this.appendValueInput("PATTERN").setCheck("Mini").appendField(new Blockly.FieldDropdown([
      ["Repeat", "*"], ["Replicate", "!"], ["Slow down", "/"],
    ]), "MODE");
    this.appendDummyInput().appendField("by").appendField(new ScrubNumber(2, 0.01), "COUNT");
    this.setInputsInline(true);
    this.setOutput(true, rhythmOutputs);
    this.setStyle("Expressions");
  },
};

type BlockState = Blockly.serialization.blocks.State;
export interface BlockChoice {
  name: string;
  category: Category;
  state: BlockState;
  aliases?: string[];
}

const entry = (category: Category, name: string, type: string, inputs?: BlockState["inputs"]): BlockChoice => ({ category, name, state: { type, inputs } });
const number = (amount: number) => ({ shadow: { type: "pd_number", fields: { VALUE: amount } } });
const mini = (pattern: string) => ({ shadow: { type: "pd_mini_text", fields: { VALUE: pattern } } });

const sourceValues = { s: "ducks", color: "#5ba8ff #a675fe", video: "ducks", image: "testcard", text: "Hello" };
const effectDefaults: Record<string, string> = { objectfit: "cover", blend: "normal" };
const rhythmNames = [["text", "Mini text"], ["atom", "Step"], ["pause", "Rest"], ["join", "Sequence / parallel"], ["group", "Group / alternate"], ["repeat", "Repeat"]];

export const blockCatalog: BlockChoice[] = [
  entry("Output", "Output layer", "pd_layer"),
  ...sources.map(([name, id]): BlockChoice => ({
    name, category: "Sources", aliases: [id],
    state: { type: "pd_source", fields: { SOURCE: id }, inputs: { VALUE: mini(sourceValues[id]) } },
  })),
  entry("Sources", "Pattern", "pd_pattern"),
  entry("Playback", "Tempo", "pd_tempo", { VALUE: number(30) }),
  entry("Playback", "Transform", "pd_transform"),
  ...effects.map(effect => {
    const args = Object.fromEntries(effect.args.flatMap((arg, index) => arg === "Value" ? [[`ARG${index}`, effectDefaults[effect.id] ? mini(effectDefaults[effect.id]) : number(1)]] : []));
    return { ...entry(effect.category, effect.label, `pd_fx_${effect.id}`, args), aliases: [effect.method] };
  }),
  entry("Expressions", "Number", "pd_number"),
  ...rhythmNames.map(([type, name]) => entry("Expressions", name, `pd_mini_${type}`)),
  entry("Signals", "Signal", "pd_signal"), entry("Signals", "Signal rate", "pd_signal_rate"), entry("Signals", "Signal range", "pd_signal_range"),
  entry("Text", "Text literal", "pd_text"),
];
