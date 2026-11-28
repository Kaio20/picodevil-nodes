import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { NodeEditor } from "./node-editor";
import { makeNode, type Graph } from "./node-graph";
import "./nodesdevil.css";

function mountEditor(initial: Graph) {
  let graph = initial;
  const host = document.createElement("div");
  host.id = "node-editor";
  document.body.append(host);
  new NodeEditor(host, {
    graph,
    view: { x: 0, y: 0, zoom: 1, previews: [] },
    save: draft => { graph = draft; },
    run: () => null,
    setMotionFactor: () => false,
    showCode: () => {},
    exportCode: () => {},
    openReference: () => {},
    openOutput: () => {},
    bindProjectionToggle: () => {},
  });
  return { host, get graph() { return graph; } };
}

it("inserts the chosen fixed dropdown option from the node search", async () => {
  const video = makeNode("video", 300, 100);
  const text = makeNode("constant", 300, 300, { mode: "text", value: "cover" });
  const editor = mountEditor({ nodes: [video, text], edges: [], variables: [] });
  const { host } = editor;
  try {
    const addNode = page.getByRole("button", { name: "Add Node" });
    const search = page.getByRole("searchbox", { name: "Search nodes" });
    const result = (name: string) => page.getByRole("button", { name, exact: true });
    const lastNode = () => editor.graph.nodes.at(-1)!;
    await addNode.click();
    await search.fill("Image Fit");
    await expect.element(result("Image Fit")).toBeVisible();
    expect(host.querySelectorAll('.nd-menu-item[data-tooltip^="Image Fit"]')).toHaveLength(1);
    await search.fill("cover");
    await result("Image Fit · Cover").click();
    expect(lastNode()).toMatchObject({ kind: "fit", data: { mode: "cover" } });

    await addNode.click();
    await search.fill("tile");
    expect([...host.querySelectorAll<HTMLElement>('.nd-menu-item[data-tooltip^="Image Fit"]')]
      .map(row => row.dataset.tooltip)).toEqual(["Image Fit · Tile", "Image Fit · Tile Center"]);
    await userEvent.keyboard("{Enter}");
    expect(lastNode()).toMatchObject({ kind: "fit", data: { mode: "tile" } });

    await addNode.click();
    await search.fill("tile");
    await result("Image Fit · Tile Center").click();
    expect(lastNode()).toMatchObject({ kind: "fit", data: { mode: "tilecenter" } });

    await addNode.click();
    await search.fill("stretch");
    await result("Image Fit · Fill").click();
    expect(lastNode()).toMatchObject({ kind: "fit", data: { mode: "fill" } });

    await addNode.click();
    await search.fill("treble");
    await result("Audio FFT · Treble").click();
    expect(lastNode()).toMatchObject({ kind: "fft", data: { band: "treble" } });

    await addNode.click();
    await search.fill("multiply");
    await expect.element(result("Multiply")).toBeVisible();
    await result("Blend · Multiply").click();
    expect(lastNode()).toMatchObject({ kind: "blend", data: { mode: "multiply" } });

    const openFromOutput = async (node: string) => {
      host.querySelector<HTMLButtonElement>(`[data-port="${node}"][data-input=""]`)!.focus();
      await userEvent.keyboard("{Enter}");
    };
    await openFromOutput(video.id);
    await search.fill("conatin");
    await result("Image Fit · Contain").click();
    expect(lastNode()).toMatchObject({ kind: "fit", data: { mode: "contain" } });
    expect(editor.graph.edges).toContainEqual({ from: video.id, to: lastNode().id, input: "image" });

    await openFromOutput(text.id);
    await search.fill("cover");
    await expect.element(result("Image Fit · Cover")).not.toBeInTheDocument();
    await search.fill("Image Fit");
    await result("Image Fit").click();
    expect(editor.graph.edges).toContainEqual({ from: text.id, to: lastNode().id, input: "mode" });
  } finally {
    host.remove();
  }
});

it("creates a typed variable from an input drag and preserves an existing source", async () => {
  const opacity = makeNode("alpha", 460, 90);
  const image = makeNode("testCard", 30, 270);
  const output = makeNode("output", 460, 270);
  const original = { from: image.id, to: output.id, input: "image" };
  const editor = mountEditor({ nodes: [opacity, image, output], edges: [original], variables: [] });
  const { host } = editor;
  try {
    for (const [node, input, y, name, type] of [
      [opacity, "value", 110, "Fade", "number"],
      [output, "image", 430, "Screen", "visual"],
    ] as const) {
      const port = host.querySelector<HTMLButtonElement>(`[data-port="${node.id}"][data-input="${input}"]`)!;
      const bounds = port.getBoundingClientRect();
      const drag = { pointerId: 1, isPrimary: true, bubbles: true, button: 0 };
      port.dispatchEvent(new PointerEvent("pointerdown", {
        ...drag, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
      }));
      document.dispatchEvent(new PointerEvent("pointerup", { ...drag, clientX: 250, clientY: y }));
      expect(host.querySelector<HTMLElement>(".nd-menu")?.hidden, name).toBe(false);
      await page.getByRole("group", { name: "Node categories" }).getByRole("button", { name: "Variables" }).click();
      await page.getByRole("button", { name: "Create Variable", exact: true }).click();
      await expect.element(page.getByRole("combobox", { name: "Variable type" })).toHaveAttribute("data-value", type);
      const draft = editor.graph.nodes.at(-1)!;
      const connected = { from: draft.id, to: node.id, input };
      expect(draft.kind).toBe("createVariable");
      expect(editor.graph.edges).toContainEqual(connected);
      expect(host.querySelector(`[data-port="${draft.id}"][data-input=""][data-type="${type}"]`)).not.toBeNull();
      if (node === output) {
        expect(editor.graph.edges).not.toContainEqual(original);
        expect(editor.graph.edges).toContainEqual({ from: image.id, to: draft.id, input: "value" });
      }
      await page.getByRole("textbox", { name: "Variable name" }).fill(name);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      const variableNode = editor.graph.nodes.at(-1)!;
      expect(variableNode.id).toBe(draft.id);
      expect(variableNode.kind).toBe("variable");
      expect(editor.graph.variables[0]).toEqual({ id: variableNode.data.variable, name, type });
      expect(editor.graph.edges).toContainEqual(connected);
      await userEvent.keyboard("{Escape}");
    }
    expect(editor.graph.edges).not.toContainEqual(original);
    expect(editor.graph.edges).toContainEqual({ from: image.id, to: editor.graph.nodes.at(-1)!.id, input: "value" });
  } finally {
    host.remove();
  }
});
