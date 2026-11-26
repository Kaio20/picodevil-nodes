import data from "virtual:reference-data";
import { javascriptLanguage } from "@codemirror/lang-javascript";

export interface CodeFragment {
  text: string;
  kind: "method" | "expression" | "example";
  layer?: boolean;
}

export const categoryColors = {
  Sources: "#5ba8ff",
  Patterns: "#beeb71",
  Playback: "#f68f37",
  Image: "#25e2cd",
  Layout: "#ffe737",
  Text: "#a675fe",
  Signals: "#20b562",
  Media: "#ff82ce",
  Output: "#e03c28",
} as const;

type Category = keyof typeof categoryColors;
type DataEntry = (typeof data)[number]["entries"][number];
export interface ReferenceParameter {
  name: string;
  description: string;
  optional: boolean;
  rest: boolean;
}
export interface ReferenceEntry extends Omit<DataEntry, "params"> {
  category: Category;
  params: ReferenceParameter[];
  summary: string;
  constant: boolean;
  fragment: CodeFragment;
}

const groups: Record<string, Category> = {
  Sources: "Sources", Effects: "Image", Controls: "Image",
  Interpolation: "Patterns", Layout: "Layout", Indexing: "Layout",
  Randomness: "Patterns", Transforms: "Patterns", Widgets: "Signals",
  Audio: "Signals", Signals: "Signals", "Signals (Strudel)": "Signals",
  "Combinators (Strudel)": "Patterns", Media: "Media", Global: "Output",
};
const playback = new Set("speed begin end start duration dur scrub rolling sync fit loopAt slice splice chop segment".toLowerCase().split(" "));
const layout = new Set("grid gridMod circle circleMod tile echo x y width height size scale scaleX scaleY rotate rotateX rotateY rotateZ i count rows cols rowscols radius startOffset circleCount".toLowerCase().split(" "));
const constants = new Set("sine sine2 sin cosine cosine2 cos tan saw saw2 isaw isaw2 tri tri2 itri itri2 square square2 perlin time mouseX mouseY rand rand2 brand silence gap nothing fft".toLowerCase().split(" "));
// Upstream documents these exports, but the bundled eval bindings omit them.
const unavailable = new Set(["chooseWith", "morph", "stepalt", "zip", "register"]);
const fieldTransforms = new Set(["addOn", "subOn", "mulOn", "divOn", "modOn", "powOn", "setOn"]);
const firstEntries = ["color", "screen", "mini", "stack", "seq", "fast", "slow", "alpha", "blend", "grid", "scale", "text", "sine", "setCps"];
const starterArgs: Record<string, string> = {
  s: '"ducks"', screen: '"ducks"', color: '"#5ba8ff"', video: '"ducks"', image: '"testcard"', text: "'Hello'",
  mini: '"red blue"', blend: '"source-over"', objectfit: '"cover"', alpha: "0.8", fontcolor: "'#ffffff'",
  fontbgcolor: "'#151515'", setcps: "0.5", setcpm: "30", crop: "0.5, 0.5, 1, 1",
  stack: 'color("red"), color("blue")', seq: 'color("red"), color("blue")',
};

function parseParameter(raw: string): ReferenceParameter {
  const match = /^(\[[^\]]+\]|[^:]+):\s*(.*)$/.exec(raw);
  const token = match?.[1] ?? raw;
  const name = token.replace(/^\[|\]$/g, "").split("=")[0];
  return { name: name.replace(/^\.\.\./, ""), description: match?.[2].replace(/^-\s*/, "") ?? "",
    optional: token.startsWith("["), rest: name.startsWith("...") };
}

function sampleArgs(entry: DataEntry, method: boolean): string | undefined {
  for (const example of entry.examples) {
    let args: string | undefined;
    javascriptLanguage.parser.parse(example).iterate({
      enter(node) {
        if (args !== undefined || node.name !== "CallExpression") return;
        const callee = node.node.firstChild;
        const list = node.node.getChild("ArgList");
        const name = callee?.name === "MemberExpression" ? callee.lastChild : callee;
        if (method !== (callee?.name === "MemberExpression")) return;
        if (!name || !list || list.lastChild?.name !== ")") return;
        if (example.slice(name.from, name.to).toLowerCase() !== entry.name.toLowerCase()) return;
        const value = example.slice(list.from + 1, list.to - 1);
        if (!value.includes("\n")) args = value;
      },
    });
    if (args !== undefined) return args;
  }
}

const extraEntries: DataEntry[] = [
  { name: "mini", description: "Build a timed pattern. Spaces play steps in order, commas play together, and angle brackets alternate each cycle.",
    params: ["pattern: steps in Strudel mininotation"], examples: ['$: color(mini("<red blue>"))'], aliases: [], isMethod: false },
];

const entries = new Map<string, ReferenceEntry>();
for (const [group, items] of [...data.map(({ name, entries }) => [name, entries] as const), ["Transforms", extraEntries] as const]) {
  for (const entry of items) {
    const key = entry.name.toLowerCase();
    if (entries.has(key) || unavailable.has(entry.name)) continue;
    let category = groups[group] ?? "Patterns";
    if (playback.has(key)) category = "Playback";
    if (layout.has(key)) category = "Layout";
    if (key.startsWith("font") || key === "text") category = "Text";
    if (key === "s" || key === "screen" || key === "color") category = "Sources";
    const constant = constants.has(key);
    const isMethod = entry.isMethod || fieldTransforms.has(entry.name) || key === "scramble";
    const args = starterArgs[key] ?? (constant ? "" : sampleArgs(entry, isMethod)) ?? "";
    const code = constant ? entry.name : `${entry.name}(${args})`;
    entries.set(key, {
      ...entry, isMethod, category, constant,
      params: entry.params.map(parseParameter),
      summary: entry.description.trim().split(/\n/)[0].replace(/\*\*|`/g, "").replace(/\s+/g, " "),
      fragment: { text: key === "fft" ? "fft[0]" : isMethod ? "." + code : code, kind: isMethod ? "method" : "expression",
        layer: category === "Sources" || key === "text" },
    });
  }
}

export const referenceCategories = Object.keys(categoryColors).map(name => ({
  name: name as Category,
  entries: [...entries.values()].filter(entry => entry.category === name).sort((a, b) => {
    const priority = (entry: ReferenceEntry) => firstEntries.indexOf(entry.name) + 1 || firstEntries.length + 1;
    return priority(a) - priority(b);
  }),
})).filter(category => category.entries.length);

const aliases = new Map<string, ReferenceEntry>();
for (const entry of entries.values()) {
  for (const alias of entry.aliases) aliases.set(alias.toLowerCase(), entry);
}

export function getReference(name: string, method: boolean): ReferenceEntry | undefined {
  const key = name.toLowerCase();
  const entry = entries.get(key) ?? aliases.get(key);
  return method && !entry?.isMethod && key !== "fontpicker" ? undefined : entry;
}

export function signature(entry: ReferenceEntry, name = entry.name, method = entry.isMethod): string {
  const prefix = method ? "." : "";
  const params = parametersFor(entry, method).map(param => `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}`);
  return entry.constant ? name : `${prefix}${name}(${params.join(", ")})`;
}

export function parametersFor(entry: ReferenceEntry, method: boolean): ReferenceParameter[] {
  return method && fieldTransforms.has(entry.name) ? entry.params.slice(1) : entry.params;
}

export const choiceValues: Record<string, readonly string[]> = {
  blend: ["source-over", "lighter", "add", "multiply", "screen", "destination-out", "subtract", "min", "max"],
  objectfit: ["cover", "contain", "fill", "none", "tile", "tilecenter"],
  smearop: ["avg", "avgl", "max", "min", "maxl", "minl", "median", "medianl", "range", "rangel", "sharpen"],
  modspace: ["uv", "tile", "screen"],
  mattespace: ["uv", "tile", "screen"],
};

export const colorArguments = new Set(["color", "fontcolor", "fontbgcolor"]);
export const ratioArguments = new Set([
  "alpha:0", "begin:0", "end:0", "duration:0", "scrub:0", "sync:0", "echo:2",
  "cropx:0", "cropy:0", "crop:0", "crop:1", "width:0", "height:0", "size:0", "size:1",
  "huerot:0", "tint:0", "slider:1", "slider:2",
]);

export const referenceDragType = "application/x-picodevil-code";
