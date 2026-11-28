import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { NodeEditor } from "./node-editor";
import { makeNode, type Graph } from "./node-graph";
import "./nodesdevil.css";

it("inserts the chosen fixed dropdown option from the node search", async () => {
  const video = makeNode("video", 300, 100);
  const text = makeNode("constant", 300, 300, { mode: "text", value: "cover" });
  let graph: Graph = { nodes: [video, text], edges: [], variables: [] };
  const host = document.createElement("div");
  host.id = "node-editor";
  document.body.append(host);
  try {
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

    const addNode = page.getByRole("button", { name: "Add Node" });
    const search = page.getByRole("searchbox", { name: "Search nodes" });
    const result = (name: string) => page.getByRole("button", { name, exact: true });
    const lastNode = () => graph.nodes.at(-1)!;
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
    expect(graph.edges).toContainEqual({ from: video.id, to: lastNode().id, input: "image" });

    await openFromOutput(text.id);
    await search.fill("cover");
    await expect.element(result("Image Fit · Cover")).not.toBeInTheDocument();
    await search.fill("Image Fit");
    await result("Image Fit").click();
    expect(graph.edges).toContainEqual({ from: text.id, to: lastNode().id, input: "mode" });
  } finally {
    host.remove();
  }
});
