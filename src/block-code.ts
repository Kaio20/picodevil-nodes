import { parse, type Expression, type CallExpression, type MemberExpression } from "acorn";
import type { Block, Workspace, serialization } from "blockly";
import { blocksToMini } from "./block-mini";

type State = serialization.blocks.State;

type Arg = "Value" | "Pattern" | "Transform";
type Category = "Playback" | "Layout" | "Image";
export interface Effect {
  id: string;
  method: string;
  label: string;
  category: Category;
  args: Arg[];
}

export const sources = [
  ["Screen / layer", "s"], ["Color", "color"], ["Video", "video"], ["Image", "image"], ["Text", "text"],
] as const;

export const effects: Effect[] = [
  { id: "sync", method: "sync", label: "Sync playback", category: "Playback", args: [] },
  { id: "fast", method: "fast", label: "Fast", category: "Playback", args: ["Value"] },
  { id: "slow", method: "slow", label: "Slow", category: "Playback", args: ["Value"] },
  { id: "speed", method: "speed", label: "Video speed", category: "Playback", args: ["Value"] },
  { id: "rev", method: "rev", label: "Reverse", category: "Playback", args: [] },
  { id: "sometimes", method: "sometimes", label: "Sometimes", category: "Playback", args: ["Transform"] },
  { id: "every", method: "every", label: "Every", category: "Playback", args: ["Value", "Transform"] },
  { id: "stack", method: "stack", label: "Stack with", category: "Layout", args: ["Pattern"] },
  { id: "stackN", method: "stackN", label: "Stack copies", category: "Layout", args: ["Value"] },
  { id: "syncStack", method: "syncStack", label: "Sync stack", category: "Layout", args: ["Value"] },
  { id: "shuffle", method: "shuffleIndex", label: "Shuffle", category: "Layout", args: [] },
  { id: "shuffleBy", method: "shuffleIndex", label: "Shuffle with", category: "Layout", args: ["Value"] },
  { id: "rows", method: "rows", label: "Rows", category: "Layout", args: ["Value"] },
  { id: "cols", method: "cols", label: "Columns", category: "Layout", args: ["Value"] },
  { id: "gridMod", method: "gridMod", label: "Apply grid", category: "Layout", args: [] },
  { id: "tile", method: "tile", label: "Tile", category: "Layout", args: [] },
  { id: "alpha", method: "alpha", label: "Opacity", category: "Image", args: ["Value"] },
  { id: "scale", method: "scale", label: "Scale", category: "Image", args: ["Value"] },
  { id: "rotate", method: "rotate", label: "Rotate", category: "Image", args: ["Value"] },
  { id: "objectfit", method: "objectfit", label: "Fit", category: "Image", args: ["Value"] },
  { id: "blend", method: "blend", label: "Blend", category: "Image", args: ["Value"] },
  { id: "barrel", method: "barrel", label: "Barrel", category: "Image", args: ["Value"] },
  { id: "croph", method: "croph", label: "Crop height", category: "Image", args: ["Value"] },
  { id: "cropw", method: "cropw", label: "Crop width", category: "Image", args: ["Value"] },
];

export const signals = ["rand", "sine", "saw", "tri", "square", "time"];
export const signalMethods = ["segment", "fast", "slow", "range"];

const effectType = (id: string) => `pd_fx_${id}`;
const byType = new Map(effects.map(effect => [effectType(effect.id), effect]));
const bareTransforms = new Set(["rev", "tile"]);
const sourceName = (name: string) => {
  const lower = name.toLowerCase();
  return lower === "screen" ? "s" : sources.find(([, id]) => id === lower)?.[1];
};

function linkAll(blocks: State[]): State | undefined {
  return blocks.reduceRight<State | undefined>((next, block) => next ? { ...block, next: { block: next } } : block, undefined);
}

const input = (block: State) => ({ block });
const field = (block: Block, name: string) => String(block.getFieldValue(name));
const unsupported = (description: string) => new Error(`${description} is not available as blocks in this prototype.`);

function simpleName(node: Expression): string | undefined {
  return node.type === "Identifier" ? node.name : undefined;
}

function methodName(node: MemberExpression): string | undefined {
  return !node.computed && node.property.type === "Identifier" ? node.property.name : undefined;
}

function memberObject(node: MemberExpression): Expression {
  if (node.object.type === "Super") throw unsupported("JavaScript super");
  return node.object;
}

function argsOf(node: CallExpression): Expression[] {
  if (node.optional || node.arguments.some(arg => arg.type === "SpreadElement")) throw unsupported("Optional calls and spread arguments");
  return node.arguments as Expression[];
}

function readArgument(node: Expression, kind: Arg, code: string): State {
  if (kind === "Pattern") return { type: "pd_pattern", inputs: { STEPS: input(readChain(node, code)) } };
  if (kind === "Transform") return readTransform(node, code);
  if (node.type === "Literal") {
    if (typeof node.value === "number" && Number.isFinite(node.value)) return { type: "pd_number", fields: { VALUE: node.value } };
    if (typeof node.value === "string") {
      const type = code[node.start] === '"' ? "pd_mini_text" : "pd_text";
      return { type, fields: { VALUE: node.value } };
    }
  }
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") {
    return { type: "pd_number", fields: { VALUE: -node.argument.value } };
  }
  if (node.type === "Identifier" && signals.includes(node.name.toLowerCase())) return { type: "pd_signal", fields: { NAME: node.name.toLowerCase() } };
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    const name = methodName(node.callee)?.toLowerCase();
    const args = argsOf(node);
    if (name === "range" && args.length === 2) {
      return { type: "pd_signal_range", inputs: {
        SIGNAL: input(readArgument(memberObject(node.callee), "Value", code)),
        MIN: input(readArgument(args[0], "Value", code)), MAX: input(readArgument(args[1], "Value", code)),
      } };
    }
    if (name && name !== "range" && signalMethods.includes(name) && args.length === 1) {
      return { type: "pd_signal_rate", fields: { NAME: name }, inputs: {
        SIGNAL: input(readArgument(memberObject(node.callee), "Value", code)), AMOUNT: input(readArgument(args[0], "Value", code)),
      } };
    }
  }
  throw unsupported(code.slice(node.start, node.end).slice(0, 72));
}

function readEffect(name: string | undefined, args: Expression[], code: string): State {
  const effect = effects.find(item => item.method.toLowerCase() === name?.toLowerCase() && item.args.length === args.length);
  if (!effect) throw unsupported(name ? `${name}(${args.length} arguments)` : "This call");
  return {
    type: effectType(effect.id),
    inputs: Object.fromEntries(args.map((arg, index) => [`ARG${index}`, input(readArgument(arg, effect.args[index], code))])),
  };
}

function readTransform(node: Expression, code: string): State {
  if (node.type === "Identifier") {
    // Zero-argument transforms can be passed directly in the text editor.
    if (!bareTransforms.has(node.name.toLowerCase())) throw unsupported(`${node.name} as a bare transform`);
    const effect = readEffect(node.name, [], code);
    return { type: "pd_transform", fields: { FORM: "factory" }, inputs: { STEPS: input(effect) } };
  }
  if (node.type === "CallExpression" && node.callee.type === "Identifier") {
    const args = argsOf(node);
    return { type: "pd_transform", fields: { FORM: "factory" }, inputs: { STEPS: input(readEffect(node.callee.name, args, code)) } };
  }
  if (node.type === "ArrowFunctionExpression" && node.params.length === 1 && node.params[0].type === "Identifier" && node.body.type !== "BlockStatement") {
    const parameter = node.params[0].name;
    const steps: State[] = [];
    let expr = node.body;
    while (expr.type === "CallExpression" && expr.callee.type === "MemberExpression") {
      steps.unshift(readEffect(methodName(expr.callee), argsOf(expr), code));
      expr = memberObject(expr.callee);
    }
    const first = linkAll(steps);
    if (first && expr.type === "Identifier" && expr.name === parameter) {
      return { type: "pd_transform", fields: { FORM: "chain" }, inputs: { STEPS: input(first) } };
    }
  }
  throw unsupported("This transform function");
}

function readChain(node: Expression, code: string): State {
  const steps: State[] = [];
  let expr = node;
  while (expr.type === "CallExpression" && expr.callee.type === "MemberExpression") {
    steps.unshift(readEffect(methodName(expr.callee), argsOf(expr), code));
    expr = memberObject(expr.callee);
  }
  if (expr.type !== "CallExpression") throw unsupported("This pattern source");
  if (expr.callee.type === "Super") throw unsupported("JavaScript super");
  const name = simpleName(expr.callee);
  const source = name && sourceName(name);
  const args = argsOf(expr);
  if (!source || args.length !== 1) throw unsupported(name ?? "This source call");
  const block: State = { type: "pd_source", fields: { SOURCE: source }, inputs: { VALUE: input(readArgument(args[0], "Value", code)) } };
  const first = linkAll(steps);
  if (first) block.next = input(first);
  return block;
}

const modes = { output: "$", label: "", hidden: "H", solo: "S", mute: "_", muteSuffix: "" } as const;
type LayerMode = keyof typeof modes | "single";
const labelSyntax = /^[_SH]?[$a-zA-Z]\w*_?$/;
const nameSyntax = /^[\w$]+$/;

function decodeLabel(label: string): [LayerMode, string] {
  if (label === "$") return ["output", ""];
  if (label.length > 1 && label.startsWith("_")) return ["mute", label.slice(1)];
  if (label.length > 1 && label.endsWith("_")) return ["muteSuffix", label.slice(0, -1)];
  if (label.length > 1 && label.startsWith("H")) return ["hidden", label.slice(1)];
  if (label.length > 1 && label.startsWith("S")) return ["solo", label.slice(1)];
  return ["label", label];
}

export function codeToWorkspace(code: string) {
  const program = parse(code, { ecmaVersion: "latest", sourceType: "script" });
  const blocks: State[] = [];
  for (const node of program.body) {
    if (node.type === "EmptyStatement") continue;
    if (node.type === "LabeledStatement" && node.body.type === "ExpressionStatement" && labelSyntax.test(node.label.name)) {
      const [mode, name] = decodeLabel(node.label.name);
      blocks.push({ type: "pd_layer", fields: { MODE: mode, NAME: name || "layer" }, inputs: { STEPS: input(readChain(node.body.expression, code)) } });
      continue;
    }
    if (node.type !== "ExpressionStatement") throw unsupported(`JavaScript ${node.type}`);
    const expr = node.expression;
    if (expr.type === "CallExpression" && expr.callee.type === "Identifier") {
      const name = expr.callee.name.toLowerCase();
      const setter = ["setCpm", "setCps"].find(method => method.toLowerCase() === name);
      const args = argsOf(expr);
      if (setter && args.length === 1) {
        blocks.push({ type: "pd_tempo", fields: { MODE: setter }, inputs: { VALUE: input(readArgument(args[0], "Value", code)) } });
        continue;
      }
    }
    if (program.body.filter(statement => statement.type !== "EmptyStatement").length === 1) {
      blocks.push({ type: "pd_layer", fields: { MODE: "single" }, inputs: { STEPS: input(readChain(expr, code)) } });
      continue;
    }
    throw unsupported("This top-level expression");
  }
  const first = linkAll(blocks);
  return { blocks: { languageVersion: 0, blocks: first ? [{ ...first, x: 32, y: 32 }] : [] } };
}

function required(block: Block, name: string): Block {
  const child = block.getInputTargetBlock(name);
  if (!child) throw new Error(`Connect an input to ${block.getFieldValue("TITLE") || block.toString(48)}.`);
  return child;
}

function valueCode(block: Block): string {
  const value = (name: string) => valueCode(required(block, name));
  if (block.type.startsWith("pd_mini_")) return JSON.stringify(blocksToMini(block));
  switch (block.type) {
    case "pd_number": return field(block, "VALUE");
    case "pd_text": return `'${JSON.stringify(field(block, "VALUE")).slice(1, -1).replaceAll("'", "\\'")}'`;
    case "pd_signal": return field(block, "NAME");
    case "pd_signal_rate": return `${value("SIGNAL")}.${field(block, "NAME")}(${value("AMOUNT")})`;
    case "pd_signal_range": return `${value("SIGNAL")}.range(${value("MIN")}, ${value("MAX")})`;
    case "pd_pattern": return chainCode(required(block, "STEPS"));
    case "pd_transform": {
      const first = required(block, "STEPS");
      const effect = byType.get(first.type);
      if (!effect) throw new Error("A transform needs an effect block.");
      if (field(block, "FORM") === "factory" && !first.getNextBlock()) {
        return bareTransforms.has(effect.method) ? effect.method : effectCode(first);
      }
      return `(pattern) => pattern${effectChain(first, ".")}`;
    }
    default: throw new Error("This input cannot produce a value.");
  }
}

function effectCode(block: Block): string {
  const effect = byType.get(block.type);
  if (!effect) throw new Error("Only effect blocks can follow a pattern source.");
  return `${effect.method}(${effect.args.map((_, index) => valueCode(required(block, `ARG${index}`))).join(", ")})`;
}

function effectChain(first: Block | null, separator: string): string {
  let code = "";
  for (let block = first; block; block = block.getNextBlock()) code += separator + effectCode(block);
  return code;
}

function chainCode(first: Block, separator = "."): string {
  if (first.type !== "pd_source") throw new Error("Start each pattern with a source block.");
  return `${field(first, "SOURCE")}(${valueCode(required(first, "VALUE"))})${effectChain(first.getNextBlock(), separator)}`;
}

export function workspaceToCode(workspace: Workspace): string {
  const statements: { code: string; single?: boolean }[] = [];
  for (const root of workspace.getTopBlocks(true)) {
    for (let block: Block | null = root; block; block = block.getNextBlock()) {
      if (!block.isEnabled()) break;
      if (block.type === "pd_tempo") {
        statements.push({ code: `${field(block, "MODE")}(${valueCode(required(block, "VALUE"))})` });
      } else if (block.type === "pd_layer") {
        const mode = field(block, "MODE") as LayerMode;
        const chain = chainCode(required(block, "STEPS"), "\n  .");
        if (mode === "single") statements.push({ code: chain, single: true });
        else if (mode === "output") statements.push({ code: `$: ${chain}` });
        else {
          const name = field(block, "NAME").trim();
          if (!nameSyntax.test(name)) throw new Error("Use letters, digits, or underscores for the layer name.");
          const label = modes[mode] + name + (mode === "muteSuffix" ? "_" : "");
          if (!labelSyntax.test(label)) throw new Error("This layer name is not supported by Picodevil.");
          statements.push({ code: `${label}: ${chain}` });
        }
      }
    }
  }
  if (!statements.length && workspace.getAllBlocks(false).length) throw new Error("Connect your blocks to a Layer or Tempo block.");
  return statements.map(statement => statement.single && statements.length > 1 ? `$: ${statement.code}` : statement.code).join("\n\n");
}
