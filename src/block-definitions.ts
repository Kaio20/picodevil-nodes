import * as Blockly from "blockly";
import { effects, signalMethods, signals, sources } from "./block-code";
import { trackPointerDrag } from "./number-drag";

const palette = {
  Sources: "#5ba8ff", Signals: "#20b562", Expressions: "#beeb71", Playback: "#f68f37",
  Layout: "#ffe737", Image: "#25e2cd", Text: "#a675fe", Variables: "#ff82ce", Output: "#e03c28",
};
type Category = keyof typeof palette;

function darken(color: string, amount: number): string {
  const channels = color.slice(1).match(/../g)!;
  return `#${channels.map(channel => Math.round(Number.parseInt(channel, 16) * amount).toString(16).padStart(2, "0")).join("")}`;
}

export const blockTheme = Blockly.Theme.defineTheme("picodevil", {
  name: "picodevil",
  blockStyles: Object.fromEntries(Object.entries(palette).map(([name, color]) => [name, {
    colourPrimary: color, colourSecondary: darken(color, 0.84), colourTertiary: darken(color, 0.67),
  }])),
  categoryStyles: Object.fromEntries(Object.entries(palette).map(([name, color]) => [name, { colour: color }])),
  componentStyles: {
    workspaceBackgroundColour: "#161719", toolboxBackgroundColour: "#202124", toolboxForegroundColour: "#dddfe2",
    flyoutBackgroundColour: "#26272a", flyoutForegroundColour: "#eeeef0", flyoutOpacity: 1,
    scrollbarColour: "#8a8a8f", scrollbarOpacity: 0.4, insertionMarkerColour: "#ffffff", insertionMarkerOpacity: 0.33,
  },
  fontStyle: { family: '"IBM Plex Mono", monospace', size: 12 },
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
    output: rhythmOutputs, style: "Expressions", inputsInline: false,
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

type ToolboxItem = Blockly.utils.toolbox.BlockInfo;
const entry = (type: string, inputs?: ToolboxItem["inputs"]): ToolboxItem => ({ kind: "block", type, ...(inputs && { inputs }) });
const number = (amount: number) => ({ shadow: { type: "pd_number", fields: { VALUE: amount } } });
const mini = (pattern: string) => ({ shadow: { type: "pd_mini_text", fields: { VALUE: pattern } } });
const category = (name: Category, contents: ToolboxItem[]) => ({ kind: "category", name, categorystyle: name, contents } as const);

export const blockToolbox = {
  kind: "categoryToolbox" as const,
  contents: [
    category("Output", [entry("pd_layer")]),
    category("Sources", [entry("pd_source", { VALUE: mini("#5ba8ff #a675fe") }), entry("pd_pattern")]),
    ...(["Playback", "Layout", "Image"] as const).map(group => category(group, [
      ...(group === "Playback" ? [entry("pd_tempo", { VALUE: number(30) }), entry("pd_transform")] : []),
      ...effects.filter(effect => effect.category === group).map(effect => {
        const defaults: Record<string, string> = { objectfit: "cover", blend: "normal" };
        const args = Object.fromEntries(effect.args.flatMap((arg, index) => arg === "Value" ? [[`ARG${index}`, defaults[effect.id] ? mini(defaults[effect.id]) : number(1)]] : []));
        return entry(`pd_fx_${effect.id}`, args);
      }),
    ])),
    category("Expressions", [entry("pd_number"), ...["text", "atom", "pause", "join", "group", "repeat"].map(kind => entry(`pd_mini_${kind}`))]),
    category("Signals", [entry("pd_signal"), entry("pd_signal_rate"), entry("pd_signal_range")]),
    category("Text", [entry("pd_text")]),
  ],
};
