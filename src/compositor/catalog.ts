import { kinds, nodes, type Kind, type Value } from "./graph";

export type Group = typeof nodes[Kind]["group"];
export interface Drop { kind: Kind; params?: Record<string, Value> }
export interface Choice extends Drop { label: string; group: Group; score: number }

export const groups: Group[] = ["Media", "Composite", "Shader", "Timing"];
export const nodeDrag = "application/x-nodesdevil-node";
export const descriptions: Record<Kind, string> = {
  video: "Loops a clip from Videos or an imported file.",
  texture: "Samples a still image, including its alpha channel.",
  audio: "Outputs a normalized microphone level or frequency band. Enable the source in Audio.",
  output: "Sends the connected image to the draft viewer. Take sends the draft to the live output.",
  merge: "Composites Foreground over Background. Factor limits the contribution of the foreground.",
  mask: "Multiplies an image’s color and alpha by the Mask, using luminance if an image is connected.",
  alpha: "Extracts an image’s alpha as a per-pixel Float.",
  displace: "Offsets Image sampling by the vector multiplied by Strength.",
  junction: "Routes one cable to any number of destinations. Double-click a cable to place one directly on it.",
  value: "Outputs a constant Float or Integer.",
  boolean: "Outputs true or false.",
  switch: "Chooses between two Float inputs using Condition.",
  color: "Outputs a single color with adjustable alpha.",
  mixColor: "Interpolates between A and B using Factor.",
  uv: "Outputs the normalized horizontal and vertical position of each pixel.",
  vector: "Combines X and Y into a two-component vector.",
  noise: "Generates smooth spatial noise. Connect Time to animate it.",
  math: "Applies the chosen arithmetic operation to A and B.",
  ramp: "Maps a Float or per-pixel luminance to a gradient.",
  expression: "Evaluates one WGSL expression returning a Float. The local inputs are a, b, uv and time.",
  time: "Outputs seconds, beats, or the phase of the current beat.",
  lfo: "Produces an oscillator between zero and one at a rate locked to the beat.",
  steps: "Loops an editable series of Float values at the chosen subdivision of the beat.",
};

const aliases: Partial<Record<Kind, string>> = {
  junction: "junction distributor cable reroute verteiler",
  steps: "pattern sequencer rhythm sequence",
  mask: "matte opacity",
  displace: "modulate warp displacement",
  merge: "blend composite mix",
  texture: "image png still",
  audio: "microphone fft sound",
};

const terms = (text: string) => text.toLowerCase().match(/[a-z\d]+/g) ?? [];

function near(a: string, b: string) {
  if (a.length < 3 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) [a, b] = [b, a];
  let edits = 0, i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length) {
      if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; continue; }
      i++;
    }
    j++;
  }
  return edits + b.length - j <= 1;
}

function score(query: string[], target: string) {
  const words = terms(target);
  const joined = words.join("");
  const key = query.join("");
  if (key === joined) return 100;
  if (joined.startsWith(key)) return 85;
  if (query.every(part => words.some(word => word.startsWith(part)))) return 75;
  if (joined.includes(key)) return 65;
  if (query.every(part => words.some(word => word.includes(part) || near(part, word)))) return 40;
  return 0;
}

export function catalog(kinds: readonly Kind[], rawQuery: string, group?: Group): Choice[] {
  const query = terms(rawQuery);
  return kinds.flatMap(kind => {
    const def = nodes[kind];
    if (!query.length) return def.group === group ? [{ kind, label: def.label, group: def.group, score: 0 }] : [];
    const rank = Math.max(score(query, def.label), score(query, aliases[kind] ?? "") * 0.9, score(query, def.group) / 4);
    let best: Choice = { kind, label: def.label, group: def.group, score: rank };
    for (const [key, parameter] of Object.entries(def.parameters)) {
      if (kind === "junction") continue;
      for (const mode of parameter.options ?? []) {
        const modeRank = Math.max(score(query, mode), score(query, `${def.label} ${mode}`));
        if (modeRank > best.score) best = { kind, label: `${def.label} · ${mode}`, group: def.group, params: { [key]: mode }, score: modeRank };
      }
    }
    return best.score ? [best] : [];
  }).sort((a, b) => b.score - a.score);
}

export function readDrop(raw: string): Drop | undefined {
  if (!raw) return;
  try {
    const item = JSON.parse(raw) as Drop;
    if (item && kinds.includes(item.kind) && (!item.params || typeof item.params === "object")) {
      const parameters = nodes[item.kind].parameters;
      const params = Object.fromEntries(Object.entries(item.params ?? {}).filter(([key, value]) => {
        const def = Object.hasOwn(parameters, key) ? parameters[key] : undefined;
        return def && typeof value === typeof def.value && (!def.options || def.options.includes(String(value)));
      }));
      return { kind: item.kind, params };
    }
  } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
}
