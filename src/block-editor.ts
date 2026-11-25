import * as Blockly from "blockly";
import { blockTheme, blockToolbox } from "./block-definitions";
import { codeToWorkspace, workspaceToCode } from "./block-code";
import { blocksToMini, miniToBlocks } from "./block-mini";
import { choiceField, type SelectChoice } from "./choice-field";
import { examples } from "./examples";
import "./block-editor.css";

export const blockStarter = `$: color("#192337")

Hink: color("<#5ba8ff #a675fe> [#25e2cd*2 ~]")

$: s("ink")
  .stackN(6)
  .rows(2)
  .cols(3)
  .gridMod()
  .scale(0.88)
  .sometimes(alpha(0.55))`;

interface BlockEditorOptions {
  run(code: string): string | null;
  openExample(code: string): void;
}

export function setupBlockEditor(host: HTMLElement, options: BlockEditorOptions) {
  host.innerHTML = `
    <div class="bd-workbar">
      <button type="button" class="bd-run" title="Run the current blocks (Ctrl+Enter)">Run</button>
      <div class="bd-examples"></div>
      <div class="bd-rhythm-actions" aria-label="Rhythm conversion">
        <button type="button" data-mini="expand" title="Turn the selected Mini text into rhythm blocks">Expand Mini</button>
        <button type="button" data-mini="text" title="Turn the selected rhythm into Mini text">As Mini text</button>
      </div>
    </div>
    <div class="bd-workspace" aria-label="Blocks workspace"></div>
    <div class="bd-footer">
      <p class="bd-status" role="status" hidden></p>
      <details class="bd-generated"><summary>Generated code</summary><pre></pre></details>
    </div>`;
  const surface = host.querySelector<HTMLElement>(".bd-workspace")!;
  const status = host.querySelector<HTMLElement>(".bd-status")!;
  const codeView = host.querySelector("pre")!;
  const available = [
    { name: "Color layers", code: blockStarter },
    ...examples.filter(example => ["space_tv", "canalslices", "ducks"].includes(example.name)),
  ];
  const choices: SelectChoice[] = [["examples", "Examples"], ...available.map((item, i): SelectChoice => [
    String(i), item.name, undefined, i === 0 ? "Block starter" : "Original patches",
  ])];
  const exampleField = choiceField(choices, "examples", "Examples", id => {
    const item = available[Number(id)];
    if (item) options.openExample(item.code);
    exampleField.setChoices(choices, "examples");
  });
  host.querySelector(".bd-examples")!.append(exampleField.field);

  const compact = window.matchMedia("(max-width: 600px)").matches;
  const workspace = Blockly.inject(surface, {
    theme: blockTheme, renderer: "zelos", toolbox: blockToolbox,
    horizontalLayout: compact,
    grid: { spacing: 24, length: 2, colour: "#46474a", snap: false },
    move: { scrollbars: true, drag: true, wheel: true },
    zoom: { controls: true, wheel: false, startScale: compact ? 0.62 : 0.88, maxScale: 1.8, minScale: 0.45 },
    trashcan: true, sounds: false,
  });
  new ResizeObserver(() => { if (!host.hidden) Blockly.svgResize(workspace); }).observe(surface);

  let imported: { original: string; generated: string } | undefined;
  let pendingPreview = false;
  let scrollToStart = false;
  let selectedId: string | undefined;

  function layout() {
    if (host.hidden) return;
    Blockly.svgResize(workspace);
    if (scrollToStart) {
      workspace.scroll(0, 0);
      scrollToStart = false;
    }
  }
  function setStatus(message: string, error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("bd-error", error);
  }

  function preview() {
    try { codeView.textContent = workspaceToCode(workspace); }
    catch (problem) { codeView.textContent = String(problem instanceof Error ? problem.message : problem); }
  }
  workspace.addChangeListener(event => {
    if (event.type === Blockly.Events.SELECTED) {
      const id = (event as Blockly.Events.Selected).newElementId;
      if (id) selectedId = id;
    }
    if (event.isUiEvent || pendingPreview) return;
    pendingPreview = true;
    requestAnimationFrame(() => { pendingPreview = false; preview(); });
  });

  function load(code: string): string | undefined {
    try {
      const state = codeToWorkspace(code);
      Blockly.serialization.workspaces.load(state, workspace);
      workspace.clearUndo();
      selectedId = undefined;
      const generated = workspaceToCode(workspace);
      imported = { original: code, generated };
      codeView.textContent = generated;
      scrollToStart = true;
      layout();
      setStatus("");
    } catch (problem) {
      return problem instanceof Error ? problem.message : String(problem);
    }
  }

  function getCode(): string {
    const generated = workspaceToCode(workspace);
    return imported?.generated === generated ? imported.original : generated;
  }

  function run() {
    try {
      const code = getCode();
      const error = options.run(code);
      setStatus(error ?? "Running", Boolean(error));
    } catch (problem) {
      setStatus(problem instanceof Error ? problem.message : String(problem), true);
    }
  }

  function convertRhythm(expand: boolean) {
    const focused = Blockly.common.getSelected();
    const selected = focused instanceof Blockly.BlockSvg && focused.workspace === workspace
      ? focused : selectedId ? workspace.getBlockById(selectedId) : null;
    if (!selected || !selected.type.startsWith("pd_mini_")) {
      setStatus("Select a rhythm block first.", true);
      return;
    }
    if ((selected.type === "pd_mini_text") !== expand) return;
    try {
      const mini = blocksToMini(selected);
      const state = expand ? miniToBlocks(mini) : { type: "pd_mini_text", fields: { VALUE: mini } };
      const target = selected.outputConnection?.targetConnection;
      const { x, y } = selected.getRelativeToSurfaceXY();
      const group = Blockly.Events.getGroup();
      Blockly.Events.setGroup(true);
      try {
        const next = Blockly.serialization.blocks.append({ ...state, x, y }, workspace, { recordUndo: true });
        if (target) {
          selected.outputConnection!.disconnect();
          target.connect(next.outputConnection!);
        }
        selected.dispose(false);
        selectedId = next.id;
        if (next instanceof Blockly.BlockSvg) next.select();
      } finally {
        Blockly.Events.setGroup(group);
      }
      preview();
      setStatus("");
    } catch (problem) {
      setStatus(problem instanceof Error ? problem.message : String(problem), true);
    }
  }

  host.querySelector(".bd-run")!.addEventListener("click", run);
  for (const button of host.querySelectorAll<HTMLButtonElement>("[data-mini]")) {
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => convertRhythm(button.dataset.mini === "expand"));
  }
  window.addEventListener("keydown", event => {
    if (host.hidden || event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    run();
  });

  return { load, getCode, run, setStatus, layout };
}
