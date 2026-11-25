import * as Blockly from "blockly";
import { afterEach, describe, expect, it } from "vitest";
import "./block-definitions";
import { codeToWorkspace, workspaceToCode } from "./block-code";
import { blocksToMini, miniToBlocks } from "./block-mini";
import { examples } from "./examples";
import { transpile } from "./transpiler";

const workspaces: Blockly.Workspace[] = [];
function workspace() {
  const next = new Blockly.Workspace();
  workspaces.push(next);
  return next;
}

afterEach(() => {
  for (const current of workspaces.splice(0)) current.dispose();
});

describe("Picodevil block prototype", () => {
  it("round-trips the original space_tv example, including its layer and transform arguments", () => {
    const code = examples.find(example => example.name === "space_tv")!.code;
    const blocks = workspace();
    Blockly.serialization.workspaces.load(codeToWorkspace(code), blocks);
    const emitted = workspaceToCode(blocks);
    const aliases = new Map([["shuffleindex", "shuffleIndex"], ["gridmod", "gridMod"]]);
    const normalize = (text: string) => transpile(text, aliases).code;
    expect(normalize(emitted)).toBe(normalize(code));
  });

  it("can switch a nested rhythm to blocks and back", () => {
    const mini = "<ducks canalboat> [ducks*2 ~]";
    const rhythm = Blockly.serialization.blocks.append(miniToBlocks(mini), workspace());
    expect(blocksToMini(rhythm)).toBe(mini);
    expect(() => miniToBlocks("ducks@3 canalboat")).toThrow(/Mini text only/);
  });

  it("keeps plain strings distinct from Mini text", () => {
    const code = String.raw`$: text('It\'s "text"').alpha("0 1")`;
    const blocks = workspace();
    Blockly.serialization.workspaces.load(codeToWorkspace(code), blocks);
    expect(transpile(workspaceToCode(blocks)).code).toBe(transpile(code).code);
  });

  it("rejects an unsupported patch instead of partially importing it", () => {
    const code = `const source = 'red'\n$: color(source)`;
    expect(() => codeToWorkspace(code)).toThrow(/VariableDeclaration/);
  });
});
