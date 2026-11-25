import { parse } from "@strudel/mini";
import type { Block, serialization } from "blockly";

type State = serialization.blocks.State;

interface MiniNode {
  type_: string;
  source_: MiniNode | MiniNode[] | string;
  arguments_?: { alignment?: string; _steps?: boolean };
  options_?: {
    ops: { type_: string; arguments_: { amount: MiniNode | number; type?: string } }[];
    weight: number;
    reps: number;
  };
}

const unsupported = () => new Error("This rhythm uses syntax that is currently available in Mini text only.");

function join(parts: State[], mode: string): State {
  const first = parts.shift();
  if (!first) throw unsupported();
  return parts.reduce((left, right) => ({
    type: "pd_mini_join",
    fields: { MODE: mode },
    inputs: { LEFT: { block: left }, RIGHT: { block: right } },
  }), first);
}

function convert(node: MiniNode): State {
  if (node.type_ === "atom" && typeof node.source_ === "string") {
    if (node.source_ === "~") return { type: "pd_mini_pause" };
    return { type: "pd_mini_atom", fields: { VALUE: node.source_ } };
  }
  if (node.type_ === "pattern" && Array.isArray(node.source_)) {
    const alignment = node.arguments_?.alignment;
    if (alignment === "polymeter_slowcat" && node.source_.length === 1) {
      return { type: "pd_mini_group", fields: { MODE: "alternate" }, inputs: { PATTERN: { block: convert(node.source_[0]) } } };
    }
    if (alignment === "fastcat" && !node.arguments_?._steps) return join(node.source_.map(convert), "sequence");
    if (alignment === "stack") return join(node.source_.map(convert), "parallel");
  }
  if (node.type_ !== "element" || typeof node.source_ === "string" || Array.isArray(node.source_) || !node.options_) {
    throw unsupported();
  }
  let result = convert(node.source_);
  if (node.source_.type_ === "pattern" && node.source_.arguments_?.alignment !== "polymeter_slowcat") {
    result = { type: "pd_mini_group", fields: { MODE: "group" }, inputs: { PATTERN: { block: result } } };
  }
  const { ops, weight, reps } = node.options_;
  if (weight !== reps) throw unsupported();
  for (const op of ops) {
    const amount = op.arguments_.amount;
    const value = typeof amount === "number" ? amount : amount?.type_ === "atom" ? Number(amount.source_) : NaN;
    let mode: string;
    if (op.type_ === "replicate") mode = "!";
    else if (op.type_ === "stretch" && op.arguments_.type === "fast") mode = "*";
    else if (op.type_ === "stretch" && op.arguments_.type === "slow") mode = "/";
    else throw unsupported();
    if (!Number.isFinite(value) || value <= 0) throw unsupported();
    result = { type: "pd_mini_repeat", fields: { MODE: mode, COUNT: value }, inputs: { PATTERN: { block: result } } };
  }
  return result;
}

export function miniToBlocks(text: string): State {
  return convert(parse(JSON.stringify(text)) as MiniNode);
}

const field = (block: Block, name: string) => String(block.getFieldValue(name));

export function blocksToMini(block: Block): string {
  const input = (name: string) => {
    const child = block.getInputTargetBlock(name);
    if (!child) throw new Error("Connect a rhythm to each open slot.");
    return blocksToMini(child);
  };
  switch (block.type) {
    case "pd_mini_text": return field(block, "VALUE");
    case "pd_mini_atom": {
      const value = field(block, "VALUE").trim();
      if (!value || /[\s()[\]<>,!?*\/@%]/.test(value)) throw new Error("A rhythm step needs a single value.");
      return value;
    }
    case "pd_mini_pause": return "~";
    case "pd_mini_join": return `${input("LEFT")}${field(block, "MODE") === "parallel" ? ", " : " "}${input("RIGHT")}`;
    case "pd_mini_group": return field(block, "MODE") === "alternate" ? `<${input("PATTERN")}>` : `[${input("PATTERN")}]`;
    case "pd_mini_repeat": {
      const child = block.getInputTargetBlock("PATTERN");
      const pattern = input("PATTERN");
      const term = child?.type === "pd_mini_atom" || child?.type === "pd_mini_pause" || child?.type === "pd_mini_group" ? pattern : `[${pattern}]`;
      return `${term}${field(block, "MODE")}${field(block, "COUNT")}`;
    }
    default: throw new Error("This input needs a rhythm block.");
  }
}
