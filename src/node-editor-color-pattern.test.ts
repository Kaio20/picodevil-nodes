import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { NodeEditor } from "./node-editor";
import { makeNode, type Graph } from "./node-graph";
import "./nodesdevil.css";

it("shows Solid-style Color inputs with swatches and resizes a Color Pattern", async () => {
  const pattern = "<red [#0f08 blue(3,8) ~] red>";
  const color = makeNode("color", 40, 40, { mode: "pattern", pattern });
  const solid = makeNode("color", 290, 40);
  let graph: Graph = {
    nodes: [color, solid],
    edges: [{ from: solid.id, to: color.id, input: "color-4" }],
    variables: [],
  };
  const host = document.createElement("div");
  host.id = "node-editor";
  document.body.append(host);
  const recentKey = "nodesdevil-recent-colors";
  const recent = localStorage.getItem(recentKey);
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

    const card = page.getByRole("article").first();
    const lastPort = card.locator('[data-input="color-4"]');
    const swatch = (step: number) => card.getByRole("button", { name: step === 1 ? "Color" : `Color ${step}`, exact: true });
    await expect.element(card.getByRole("textbox")).not.toBeInTheDocument();
    await expect.element(lastPort).toHaveAttribute("data-type", "color");
    await expect.element(swatch(1)).toHaveAttribute("title", "#ff0000");
    await expect.element(swatch(3)).toHaveAttribute("title", "#0000ff");
    await expect.element(swatch(4)).not.toBeInTheDocument();

    const pick = async (step: number, value: string) => {
      const picker = page.getByRole("dialog", { name: `Color ${step} picker` });
      await expect.element(picker).toBeVisible();
      await picker.getByRole("textbox", { name: "Hex" }).fill(value);
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard("{Escape}");
    };

    await swatch(2).click();
    await expect.element(page.getByRole("textbox", { name: "Hex" })).toHaveValue("#00ff0088");
    await pick(2, "#10203080");
    expect(graph.nodes[0].data.pattern).toBe("<red [#10203080 blue(3,8) ~] red>");

    const remove = card.getByRole("button", { name: "Remove last color", exact: true });
    await remove.click();
    expect(graph.edges).toHaveLength(0);
    await expect.element(lastPort).not.toBeInTheDocument();
    await card.getByRole("button", { name: "Add color", exact: true }).click();
    await swatch(4).click();
    await pick(4, "#abcdef");
    expect(graph.nodes[0].data["color-4"]).toEqual({ hex: "#abcdef", alpha: 1 });
    await expect.element(swatch(2)).toHaveAttribute("title", "#10203080");

    await remove.click();
    await remove.click();
    await remove.click();
    await expect.element(remove).toBeDisabled();
    await expect.element(swatch(1)).toHaveAttribute("title", "#ff0000");
  } finally {
    host.remove();
    if (recent === null) localStorage.removeItem(recentKey);
    else localStorage.setItem(recentKey, recent);
  }
});
