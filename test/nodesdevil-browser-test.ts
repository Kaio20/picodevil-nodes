import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { diffPixels, renderAndSettle, seedMedia, startHarness } from "./harness";
import { examples } from "../src/examples";

async function center(locator: Locator) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await locator.waitFor();
    const rect = await locator.boundingBox();
    if (rect) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  assert.fail("Could not locate a stable drag target: " + locator);
}

async function besidePort(port: Locator, side: "left" | "right") {
  const rect = await port.boundingBox();
  assert(rect);
  return { x: side === "left" ? rect.x - 6 : rect.x + rect.width + 6, y: rect.y + rect.height / 2 };
}

async function drag(page: Page, source: Locator, destination: Locator | { x: number; y: number }) {
  const from = await center(source);
  const to = "boundingBox" in destination ? await center(destination) : destination;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.mouse.up();
}

async function choose(card: Locator, picker: Locator, name: string) {
  await picker.click();
  await card.getByRole("option", { name, exact: true }).click();
}

async function pixel(canvas: Locator, x = 0.03, y = 0.03) {
  return canvas.evaluate((node, point) => {
    const c = node as HTMLCanvasElement;
    return [...c.getContext("2d")!.getImageData(Math.floor(c.width * point.x), Math.floor(c.height * point.y), 1, 1).data];
  }, { x, y });
}

async function waitPixel(canvas: Locator, test: (rgba: number[]) => boolean) {
  const end = Date.now() + 20000;
  let rgba: number[];
  do {
    rgba = await pixel(canvas);
    if (test(rgba)) return rgba;
    await new Promise(resolve => setTimeout(resolve, 80));
  } while (Date.now() < end);
  rgba = await pixel(canvas);
  if (test(rgba)) return rgba;
  assert.fail("Canvas did not reach expected color: " + rgba);
}

const { browser, page, url, close } = await startHarness({
  headless: !process.argv.includes("--headed"),
  viewport: { width: 1600, height: 900 },
  pinMediaToOrigin: true,
});

try {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.locator(".nd-node").first().waitFor();
  assert.equal(await page.title(), "NodesDevil");
  const sidebarToggle = page.locator("#sidebar-toggle");
  const referenceTab = page.locator("#tab-reference");
  const currentReference = referenceTab.locator('[aria-current="location"]');
  const tooltip = page.getByRole("tooltip");
  const hoverTooltip = async (control: Locator, text: RegExp) => {
    await page.mouse.move(0, 0);
    await control.hover();
    await tooltip.waitFor();
    assert.match(await tooltip.innerText(), text);
  };
  const testCardTitle = page.locator('[data-kind="testCard"] .nd-node-title');
  await hoverTooltip(testCardTitle, /built-in test image/);
  const tooltipBox = await tooltip.boundingBox();
  assert(tooltipBox && tooltipBox.y + tooltipBox.height < (await center(testCardTitle)).y);
  assert.equal(await tooltip.evaluate(tip => getComputedStyle(tip).pointerEvents), "none");
  assert.equal(await testCardTitle.getAttribute("title"), null);
  await page.keyboard.press("Escape");
  await tooltip.waitFor({ state: "hidden" });
  const run = page.locator(".nd-toolbar").getByRole("button", { name: /Run/ });
  await hoverTooltip(run, /Ctrl\/Cmd\+Enter/);
  assert((await tooltip.boundingBox())!.y > (await center(run)).y);
  await sidebarToggle.click();
  await testCardTitle.click();
  await currentReference.waitFor();
  assert.equal(await currentReference.textContent(), "Test Card");
  assert.equal(await page.locator("#sidebar-panel.open").count(), 1);
  await page.locator('button[data-tab="videos"]').click();
  const projection = page.getByRole("button", { name: "Projection", exact: true });
  const projectionPanel = page.locator("#nd-projection");
  const projectionStage = page.locator(".nd-projection-stage");
  await projectionPanel.waitFor();
  assert.equal(await projection.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#c").isVisible(), false);
  await waitPixel(projectionStage.locator("canvas"), rgba => rgba[0] > 210 && rgba[3] === 255);
  await projection.click();
  assert.equal(await projectionPanel.isVisible(), false);
  await waitPixel(page.locator('[data-kind="testCard"] .nd-thumbnail'), rgba => rgba[0] > 210 && rgba[3] === 255);
  await seedMedia(page, [
    { name: "nodes-red", url: url + "/test-assets/red.mp4" },
    { name: "nodes-blue", url: url + "/test-assets/blue.png" },
  ]);
  const clip = page.locator(".thumb-cell").filter({ hasText: "nodes-red" });
  const image = page.locator(".thumb-cell").filter({ hasText: "nodes-blue" });
  await drag(page, image, clip);
  assert.equal(await page.locator(".nd-node").count(), 2);
  const order = await page.locator(".thumb-cell .thumb-label").allTextContents();
  assert(order.indexOf("nodes-blue") < order.indexOf("nodes-red"));
  const outputInput = page.locator('[data-kind="output"] [data-input="image"]');
  await outputInput.click({ button: "right" });
  const clipCenter = await center(clip);
  const clipBox = await clip.boundingBox();
  assert(clipBox);
  const dropPoint = await besidePort(outputInput, "left");
  await page.mouse.move(clipCenter.x, clipCenter.y);
  await page.mouse.down();
  await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 14 });
  const dragPreview = page.locator(".drag-clone");
  const previewBox = await dragPreview.boundingBox();
  assert(previewBox);
  assert(Math.abs(previewBox.width - clipBox.width) < 1);
  assert(Math.abs(previewBox.height - clipBox.height) < 1);
  assert(Math.abs(previewBox.x + previewBox.width / 2 - dropPoint.x) < 1);
  assert(Math.abs(previewBox.y + previewBox.height / 2 - dropPoint.y) < 1);
  assert.equal(await dragPreview.locator(".thumb-label").textContent(), "nodes-red");
  assert.equal(await page.locator(".nd-drop-ghost").isVisible(), false);
  await page.mouse.up();
  assert.equal(await dragPreview.count(), 0);
  const source = page.locator('[data-kind="video"]');
  await source.waitFor();
  assert.equal(await source.count(), 1);
  assert.equal(await page.locator(".nd-wire-hit").count(), 1);
  await source.getByRole("button", { name: "Preview nodes-red" }).click();
  const red = await waitPixel(source.locator("canvas"), rgba => rgba[0] > 180 && rgba[1] < 50 && rgba[3] === 255);

  const open = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open Output" }).click();
  const output = await open;
  await output.waitForLoadState();
  assert.equal(await output.title(), "NodesDevil Output");
  const stage = output.locator("canvas");
  const testCard = await waitPixel(stage, rgba => rgba[0] > 210 && rgba[1] > 210);
  const graph = await page.locator(".nd-viewport").boundingBox();
  assert(graph);

  const sourceOutput = source.locator('[data-input=""]');
  const cardOutput = page.locator('[data-kind="testCard"] [data-input=""]');
  const blank = { x: graph.x + 440, y: graph.y + 315 };
  const wires = page.locator(".nd-wire-hit");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const cableSearch = page.getByRole("searchbox", { name: "Search nodes" });
  await drag(page, outputInput, blank);
  await cableSearch.waitFor();
  assert.equal(await wires.count(), 1);
  await cableSearch.press("Escape");
  assert.equal(await wires.count(), 0);
  assert.equal(await cableSearch.isVisible(), false);
  await undo.click();
  assert.equal(await wires.count(), 1);

  for (const socket of [outputInput, sourceOutput]) {
    await drag(page, socket, blank);
    await cableSearch.waitFor();
    assert.equal(await wires.count(), 1);
    await cableSearch.fill("Brightness");
    await page.getByRole("button", { name: "Brightness", exact: true }).click();
    assert.equal(await wires.count(), 2);
    const newOutput = page.locator('[data-kind="brightness"] [data-input=""]');
    const connected = (await newOutput.getAttribute("data-tooltip"))?.includes("Alt-click");
    assert.equal(connected, socket === outputInput);
    assert.equal(await cableSearch.isVisible(), false);
    await undo.click();
    assert.equal(await page.locator('[data-kind="brightness"]').count(), 0);
    assert.equal(await wires.count(), 1);

    await socket.click({ modifiers: ["Alt"] });
    assert.equal(await wires.count(), 0);
    await undo.click();
    assert.equal(await wires.count(), 1);
  }

  const sourceCenter = await center(sourceOutput);
  for (const cancel of [false, true]) {
    await page.mouse.move(sourceCenter.x, sourceCenter.y);
    await page.mouse.down();
    await page.mouse.move(blank.x, blank.y, { steps: 8 });
    assert.equal(await page.locator(".nd-wire-drag").count(), 1);
    assert.equal(await page.locator(".nd-wire-muted").count(), 0);
    if (cancel) await page.keyboard.press("Escape");
    else await page.mouse.move(sourceCenter.x, sourceCenter.y, { steps: 8 });
    await page.mouse.up();
    assert.equal(await wires.count(), 1);
  }

  await drag(page, sourceOutput, blank);
  await cableSearch.waitFor();
  assert.equal(await wires.count(), 1);
  await page.mouse.click(graph.x + 90, graph.y + 475);
  assert.equal(await wires.count(), 1);
  assert.equal(await cableSearch.isVisible(), false);
  await drag(page, sourceOutput, blank);
  const nodeResults = page.locator(".nd-menu-results");
  await page.locator(".nd-menu-category").first().waitFor();
  assert.equal(await nodeResults.isVisible(), false);
  assert.equal(await page.locator('.nd-menu-category[data-category="Output"]').count(), 0);
  await page.locator('.nd-menu-category[data-category="Image"]').hover();
  await nodeResults.getByRole("button", { name: "Hue Rotate", exact: true }).waitFor();
  await cableSearch.hover();
  assert.equal(await nodeResults.isVisible(), false);
  await cableSearch.fill("rot hue");
  assert.equal(await nodeResults.getByRole("button").first().getAttribute("data-tooltip"), "Hue Rotate");
  await page.getByRole("button", { name: "Hue Rotate", exact: true }).click();
  const hue = page.locator('[data-kind="hue"]');
  assert.equal(await wires.count(), 2);
  await outputInput.click({ modifiers: ["Alt"] });
  assert.equal(await wires.count(), 1);
  await drag(page, sourceOutput, await besidePort(outputInput, "left"));
  assert.equal(await wires.count(), 2);
  await undo.click();
  assert.equal(await wires.count(), 1);
  await drag(page, outputInput, await besidePort(sourceOutput, "right"));
  assert.equal(await wires.count(), 2);
  await drag(page, sourceOutput, cardOutput);
  assert.equal(await wires.count(), 2);
  assert.doesNotMatch(await cardOutput.getAttribute("data-tooltip") ?? "", /Alt-click/);
  assert.match(await sourceOutput.getAttribute("data-tooltip") ?? "", /Alt-click/);
  await sourceOutput.click({ modifiers: ["Alt"] });
  assert.equal(await wires.count(), 0);
  await undo.click();
  assert.equal(await wires.count(), 2);
  assert.match(await sourceOutput.getAttribute("data-tooltip") ?? "", /Alt-click/);
  await hue.getByRole("button", { name: "Preview Hue Rotate" }).click();
  const firstHue = await waitPixel(hue.locator("canvas"), rgba => rgba[3] === 255 && rgba.slice(0,3).some((channel, i) => Math.abs(channel - red[i]) > 35));
  await drag(page, hue.locator('[data-input=""]'), { x: graph.x + 695, y: graph.y + 350 });
  await cableSearch.fill("grid");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  const grid = page.locator('[data-kind="grid"]');
  await grid.getByRole("button", { name: "Preview Grid" }).click();
  await waitPixel(grid.locator("canvas"), rgba => rgba[3] === 255);

  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("Brightness");
  await page.getByRole("button", { name: "Brightness", exact: true }).click();
  const brightness = page.locator('[data-kind="brightness"]');
  const wire = page.locator(".nd-wire-hit").last();
  const wireMidpoint = await wire.evaluate(node => {
    const path = node as SVGPathElement;
    const length = path.getTotalLength() / 2;
    const matrix = path.getScreenCTM()!;
    const point = path.getPointAtLength(length).matrixTransform(matrix);
    const next = path.getPointAtLength(length + 1).matrixTransform(matrix);
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const size = Math.hypot(dx, dy);
    return { x: point.x, y: point.y, nearX: point.x - 13 * dy / size, nearY: point.y + 13 * dx / size };
  });
  const wireWidth = () => wire.evaluate(hit => parseFloat(getComputedStyle(hit.previousElementSibling!).strokeWidth));
  const normalWidth = await wireWidth();
  await page.mouse.move(wireMidpoint.x, wireMidpoint.y);
  assert((await wireWidth()) > normalWidth);
  await page.mouse.move(0, 0);
  assert.equal(await wireWidth(), normalWidth);

  await page.keyboard.down("Alt");
  await page.mouse.click(wireMidpoint.x, wireMidpoint.y);
  await page.keyboard.up("Alt");
  assert.equal(await wires.count(), 2);
  await undo.click();
  assert.equal(await wires.count(), 3);

  const insert = page.getByRole("button", { name: "Insert node here", exact: true });
  await brightness.locator("header").click({ position: { x: 4, y: 12 } });
  await page.mouse.move(wireMidpoint.nearX, wireMidpoint.nearY);
  await insert.waitFor();
  assert.equal(await wires.count(), 3);
  await page.keyboard.press("Escape");
  assert.equal(await insert.isVisible(), false);
  await page.mouse.move(wireMidpoint.x, wireMidpoint.y);
  await insert.click();
  assert.equal(await wires.count(), 4);
  assert.equal(await brightness.locator(".nd-connected").count(), 1);
  await undo.click();
  assert.equal(await wires.count(), 3);
  assert.equal(await brightness.locator(".nd-connected").count(), 0);
  for (const row of [grid.locator(".nd-connected").getByText("Image", { exact: true }), hue.locator(".nd-port-out").getByText("Image", { exact: true })]) {
    await page.keyboard.press("Escape");
    await row.hover();
    await insert.waitFor();
    assert.equal(await wires.count(), 3);
    await insert.click();
    assert.equal(await wires.count(), 4);
    await undo.click();
  }
  const brightnessHeader = brightness.locator("header");
  const anchors = [brightness, brightness.locator('[data-input="image"]'), brightness.locator('[data-input=""]')];
  for (const [index, anchor] of anchors.entries()) {
    const header = await center(brightnessHeader);
    const from = { x: header.x - 52, y: header.y };
    const snap = await center(anchor);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(wireMidpoint.x + from.x - snap.x, wireMidpoint.y + from.y - snap.y, { steps: 14 });
    await insert.waitFor();
    assert.equal(await insert.isEnabled(), false);
    await page.mouse.up();
    assert.equal(await wires.count(), 4);
    if (index < anchors.length - 1) await undo.click();
  }
  await brightness.locator("header").click({ button: "right" });
  await page.getByRole("button", { name: "Detach from chain" }).click();
  assert.equal(await page.locator(".nd-wire-hit").count(), 3);
  await brightness.locator("header").click({ button: "right" });
  await page.getByRole("button", { name: "Delete node" }).click();

  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("Output");
  assert.equal(await nodeResults.getByRole("button", { name: "Output", exact: true }).count(), 1);
  await cableSearch.clear();
  const outputCategory = page.locator('.nd-menu-category[data-category="Output"]');
  assert.equal(await outputCategory.evaluate(category => (category.nextElementSibling as HTMLElement)?.dataset.category), "Variables");
  await outputCategory.click();
  assert.equal(await page.locator('[data-kind="output"]').count(), 2);
  await undo.click();

  const outputs = page.locator('[data-kind="output"]');
  const originalOutput = outputs.first();
  const originalHeader = originalOutput.locator("header");
  await originalHeader.click({ position: { x: 4, y: 12 } });
  await page.keyboard.press("Delete");
  assert.equal(await outputs.count(), 1);
  assert.equal(await wires.count(), 3);
  const deleteNode = page.getByRole("button", { name: "Delete node" });
  await originalHeader.click({ button: "right" });
  assert.equal(await deleteNode.count(), 0);
  await page.getByRole("button", { name: "Duplicate node" }).click();
  assert.equal(await outputs.count(), 2);
  const branchOutput = outputs.last();
  const branchHeader = branchOutput.locator("header");
  assert.notEqual(await branchOutput.getAttribute("data-node-id"), await originalOutput.getAttribute("data-node-id"));
  assert.equal(await branchOutput.getByRole("combobox", { name: "Layer order" }).getAttribute("data-value"), "1");
  assert.equal(await wires.count(), 3);

  await originalHeader.click({ button: "right" });
  await deleteNode.click();
  assert.equal(await outputs.count(), 1);
  await undo.click();
  await branchHeader.click({ position: { x: 4, y: 12 } });
  await page.keyboard.press("Delete");
  assert.equal(await outputs.count(), 1);
  await undo.click();
  await branchHeader.click({ position: { x: 4, y: 12 } });
  await page.mouse.move(wireMidpoint.x, wireMidpoint.y);
  const branch = page.getByRole("button", { name: "Connect as branch", exact: true });
  await branch.click();
  assert.equal(await wires.count(), 4);
  assert.equal(await branchOutput.locator(".nd-connected").count(), 1);
  assert.equal(await grid.locator(".nd-connected").count(), 1);
  await undo.click();
  await undo.click();
  assert.equal(await page.locator('[data-kind="output"]').count(), 1);
  assert.equal(await wires.count(), 3);

  const turns = hue.getByRole("spinbutton", { name: "Turns" });
  await turns.fill("0.6");
  await turns.press("Tab");
  const secondHue = await waitPixel(hue.locator("canvas"), rgba => rgba[3] === 255 && rgba.slice(0,3).some((channel, i) => Math.abs(channel - firstHue[i]) > 35));
  await waitPixel(grid.locator("canvas"), rgba => rgba[3] === 255 && rgba.slice(0,3).every((channel, i) => Math.abs(channel - secondHue[i]) < 15));
  assert.deepEqual(await pixel(stage), testCard);
  await drag(page, grid.locator('[data-input=""]'), outputInput);
  const outputRun = originalOutput.getByRole("button", { name: /Run/ });
  assert.match(await outputRun.getAttribute("class") ?? "", /\bpending\b/);
  await outputRun.click();
  await waitPixel(stage, rgba => rgba.slice(0,3).every((channel, i) => Math.abs(channel - secondHue[i]) < 15));
  assert.doesNotMatch(await outputRun.getAttribute("class") ?? "", /\bpending\b/);
  assert.doesNotMatch(await run.getAttribute("class") ?? "", /\bpending\b/);

  const initialTurns = await turns.inputValue();
  await turns.click();
  assert(await turns.evaluate(input => document.activeElement === input));
  assert.equal(await turns.inputValue(), initialTurns);
  const turnsCenter = await center(turns);
  await page.mouse.move(turnsCenter.x, turnsCenter.y);
  await page.mouse.down();
  await page.mouse.move(turnsCenter.x + 80, turnsCenter.y, { steps: 8 });
  const increasedTurns = await turns.inputValue();
  assert(Number(increasedTurns) > Number(initialTurns));
  await page.mouse.up();
  await drag(page, turns, { x: turnsCenter.x - 80, y: turnsCenter.y });
  assert(Number(await turns.inputValue()) < Number(increasedTurns));
  await undo.click();
  assert.equal(await turns.inputValue(), increasedTurns);
  await undo.click();
  assert.equal(await turns.inputValue(), initialTurns);

  await page.mouse.move(turnsCenter.x, turnsCenter.y);
  await page.mouse.down();
  await page.mouse.move(turnsCenter.x, turnsCenter.y - 24);
  const raisedTurns = Number(await turns.inputValue());
  assert(raisedTurns > Number(initialTurns));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(Number(await turns.inputValue()), raisedTurns);
  await page.mouse.move(turnsCenter.x, turnsCenter.y - 48);
  const acceleratedTurns = Number(await turns.inputValue());
  assert(acceleratedTurns - raisedTurns > raisedTurns - Number(initialTurns));
  await page.mouse.move(turnsCenter.x + 24, turnsCenter.y - 36, { steps: 8 });
  const diagonalTurns = Number(await turns.inputValue());
  assert(diagonalTurns > acceleratedTurns);
  await page.mouse.move(turnsCenter.x + 24, turnsCenter.y - 12, { steps: 8 });
  assert(Number(await turns.inputValue()) < diagonalTurns);
  await page.mouse.up();
  await undo.click();
  assert.equal(await turns.inputValue(), initialTurns);

  const rows = grid.getByRole("spinbutton", { name: "Rows" });
  assert.equal(await rows.inputValue(), "");
  const rowsCenter = await center(rows);
  await page.mouse.move(rowsCenter.x, rowsCenter.y);
  await page.mouse.down();
  await page.mouse.move(rowsCenter.x + 13, rowsCenter.y);
  assert.equal(await rows.inputValue(), "1");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await rows.inputValue(), "");

  await projection.click();
  const rounding = projectionPanel.locator("header").getByRole("spinbutton", { name: "Corner Radius", exact: true });
  const resetProjection = projectionPanel.getByRole("button", { name: "Reset", exact: true });
  const radiusCenter = await center(rounding);
  assert(Math.abs(radiusCenter.y - (await center(resetProjection)).y) < 1);
  assert.equal(await rounding.inputValue(), "0");
  await rounding.click();
  assert(await rounding.evaluate(input => document.activeElement === input));
  await drag(page, rounding, { x: radiusCenter.x, y: radiusCenter.y - 36 });
  const draggedRadius = Number(await rounding.inputValue());
  assert(draggedRadius > 0);
  assert.notEqual(await stage.evaluate(canvas => getComputedStyle(canvas).clipPath), "none");
  await page.mouse.move(radiusCenter.x, radiusCenter.y);
  await page.mouse.down();
  await page.mouse.move(radiusCenter.x - 24, radiusCenter.y);
  assert(Number(await rounding.inputValue()) < draggedRadius);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(Number(await rounding.inputValue()), draggedRadius);
  const before = await projectionStage.boundingBox();
  assert(before);
  const grip = page.getByRole("button", { name: "Resize projection preview" });
  const gripCenter = await center(grip);
  await drag(page, grip, { x: gripCenter.x - 130, y: gripCenter.y - 75 });
  const after = await projectionStage.boundingBox();
  assert(after);
  assert(after.width > before.width + 80);
  assert(Math.abs(after.width / after.height - before.width / before.height) < 0.01);
  assert(Math.abs(after.width / after.height - await stage.evaluate(node => {
    const outputCanvas = node as HTMLCanvasElement;
    return outputCanvas.width / outputCanvas.height;
  })) < 0.01);
  assert(await projectionStage.evaluate(stage => {
    const { left, top, width, height } = stage.getBoundingClientRect();
    return stage.contains(document.elementFromPoint(left + width / 2, top + height / 2));
  }));
  await rounding.fill("100");
  await rounding.press("Tab");
  for (const projectedCanvas of [projectionStage.locator("canvas"), stage]) {
    await projectedCanvas.evaluate(canvas => {
      const { width, height } = canvas.getBoundingClientRect();
      const clipPath = getComputedStyle(canvas).clipPath;
      const circle = clipPath.match(/^inset\(([\d.]+)px ([\d.]+)px round ([\d.]+)px\)$/);
      if (!circle) throw new Error(`Expected a circular projection, got ${clipPath}`);
      const [, insetY, insetX, radius] = circle.map(Number);
      if (Math.abs(width / 2 - insetX - radius) > 0.1 || Math.abs(height / 2 - insetY - radius) > 0.1) {
        throw new Error(`Projection mask ${clipPath} does not form a circle in ${width} × ${height}`);
      }
    });
  }
  await resetProjection.click();
  assert.equal(await rounding.inputValue(), "0");
  assert.equal(await stage.evaluate(canvas => getComputedStyle(canvas).clipPath), "none");
  const projectionGrid = projectionPanel.getByRole("button", { name: "Grid", exact: true });
  const previewGrid = projectionStage.locator(".nd-projection-grid");
  const outputGrid = output.locator(".nd-projection-grid");
  assert.equal(await projectionGrid.getAttribute("aria-pressed"), "false");
  await projectionGrid.click();
  assert.equal(await projectionGrid.getAttribute("aria-pressed"), "true");
  await previewGrid.waitFor();
  await outputGrid.waitFor();

  const cornerPositions = () => projectionStage.locator(".nd-projection-corner").evaluateAll(handles =>
    handles.map(handle => {
      const { left, top } = (handle as HTMLElement).style;
      return [Number.parseFloat(left), Number.parseFloat(top)];
    }));
  const frame = await projectionStage.boundingBox();
  assert(frame);
  const leftEdge = projectionPanel.getByRole("button", { name: "Left edge", exact: true });
  const grab = { x: frame.x, y: frame.y + frame.height / 4 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + frame.width / 5, grab.y + 20, { steps: 10 });
  await page.mouse.up();
  const [topLeft, topRight, bottomRight, bottomLeft] = await cornerPositions();
  assert(Math.abs(topLeft[0] - 20) < 0.5);
  assert.deepEqual([topLeft[1], bottomLeft[1]], [0, 100]);
  assert.equal(bottomLeft[0], topLeft[0]);
  assert.deepEqual([topRight, bottomRight], [[100, 0], [100, 100]]);
  assert.equal(await outputGrid.evaluate(el => (el as HTMLElement).style.transform),
    await stage.evaluate(canvas => (canvas as HTMLCanvasElement).style.transform));

  const moved = await cornerPositions();
  const edgeCenter = await center(leftEdge);
  await page.mouse.move(edgeCenter.x, edgeCenter.y);
  await page.mouse.down();
  await page.mouse.move(edgeCenter.x + 30, edgeCenter.y);
  assert.notDeepEqual(await cornerPositions(), moved);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await cornerPositions(), moved);

  await leftEdge.press("Shift+ArrowLeft");
  const [keyTopLeft, , , keyBottomLeft] = await cornerPositions();
  assert(Math.abs(keyTopLeft[0] - (topLeft[0] - 5)) < 0.01);
  assert.equal(keyBottomLeft[0], keyTopLeft[0]);
  const corner = page.getByRole("button", { name: "Top left", exact: true });
  await corner.press("Shift+ArrowRight");
  await corner.press("Shift+ArrowDown");
  const angled = await cornerPositions();
  const angledCenter = await center(leftEdge);
  await drag(page, leftEdge, { x: angledCenter.x + 30, y: angledCenter.y - 5 });
  const shifted = await cornerPositions();
  for (const axis of [0, 1]) {
    const delta = shifted[0][axis] - angled[0][axis];
    assert(Math.abs(delta) > 1);
    assert(Math.abs(delta - (shifted[3][axis] - angled[3][axis])) < 0.001);
  }
  assert.deepEqual(shifted.slice(1, 3), angled.slice(1, 3));
  await rounding.fill("45");
  assert.equal(await outputGrid.evaluate(el => (el as HTMLElement).style.clipPath),
    await stage.evaluate(canvas => (canvas as HTMLCanvasElement).style.clipPath));
  await resetProjection.click();
  assert.equal(await projectionGrid.getAttribute("aria-pressed"), "true");
  await page.keyboard.down("Shift");
  try {
    await drag(page, corner, { x: frame.x + frame.width / 4, y: frame.y + frame.height / 4 });
  } finally {
    await page.keyboard.up("Shift");
  }
  const scaled = await cornerPositions();
  for (const [index, expected] of [[25, 25], [100, 25], [100, 100], [25, 100]].entries()) {
    assert(Math.abs(scaled[index][0] - expected[0]) < 0.5);
    assert(Math.abs(scaled[index][1] - expected[1]) < 0.5);
  }
  const scaledOutput = await stage.evaluate(canvas => {
    const { width, height } = canvas.getBoundingClientRect();
    return [width / innerWidth, height / innerHeight];
  });
  assert(scaledOutput.every(scale => Math.abs(scale - 0.75) < 0.005));
  await resetProjection.click();
  await corner.press("Shift+ArrowRight");
  await corner.press("Shift+ArrowDown");
  await output.waitForFunction(() => document.querySelector("canvas")?.style.transform.includes("matrix3d"));
  const screenshot = (await output.screenshot()).toString("base64");
  const outside = await output.evaluate(async data => {
    const image = new Image();
    image.src = "data:image/png;base64," + data;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(3, 3, 1, 1).data];
  }, screenshot);
  assert.deepEqual(outside, [0, 0, 0, 255]);
  await output.keyboard.press("f");
  await output.waitForFunction(() => document.fullscreenElement !== null);
  assert(await outputGrid.isVisible());
  await projectionGrid.click();
  assert.equal(await projectionGrid.getAttribute("aria-pressed"), "false");
  await previewGrid.waitFor({ state: "hidden" });
  await outputGrid.waitFor({ state: "hidden" });
  await output.close();
  await projection.click();

  await page.locator("#tab-videos").getByRole("button", { name: "Switch to edit view" }).click();
  const name = page.locator(".vid-row").filter({ has: page.locator('input.vid-name') }).locator('input.vid-name');
  const names = await name.all();
  for (const item of names) {
    if (await item.inputValue() !== "nodes-red") continue;
    await item.fill("nodes-red-renamed");
    await item.press("Tab");
    break;
  }
  await source.getByRole("button", { name: "Preview nodes-red-renamed" }).waitFor();
  await hoverTooltip(source.getByRole("combobox", { name: "Video 1" }), /^nodes-red-renamed\nVideo$/);
  const mediaRow = page.locator(".vid-row").filter({ has: page.locator('[title=\'Insert "nodes-red-renamed"\']') });
  await drag(page, mediaRow.locator(".vid-thumb"), { x: graph.x + 210, y: graph.y + 570 });
  assert.equal(await source.count(), 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await source.count(), 1);
  await page.reload();
  await source.getByRole("button", { name: "Preview nodes-red-renamed" }).waitFor();
  assert.equal(await page.locator(".nd-node").count(), 5);
  assert.equal(await page.locator(".nd-preview").count(), 4);
  const playbackMode = source.getByRole("combobox", { name: "Video playback" });
  assert.equal(await playbackMode.getAttribute("data-value"), "clipEnd");
  await source.getByRole("button", { name: "Add video" }).click();
  await source.getByRole("combobox", { name: "Video 2" }).waitFor();
  assert.equal(await source.locator('[data-input="clip-2"]').getAttribute("data-type"), "text");
  await playbackMode.click();
  assert.deepEqual(await source.getByRole("option").allTextContents(), ["Until Clip Ends", "List per Cycle", "One Video per Cycle"]);
  await source.getByRole("option", { name: "One Video per Cycle" }).click();
  assert.equal(await playbackMode.getAttribute("data-value"), "clipPerCycle");
  await undo.click();
  await undo.click();
  assert.equal(await source.getByRole("combobox", { name: "Video 2" }).count(), 0);
  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("Index");
  await nodeResults.getByRole("button", { name: "Index", exact: true }).click();
  const indexNode = page.locator('[data-kind="index"]');
  await indexNode.getByRole("button", { name: "Add image" }).click();
  await indexNode.getByRole("button", { name: "Add image" }).click();
  assert.equal(await indexNode.locator('[data-input="image-3"]').getAttribute("data-type"), "visual");
  await undo.click();
  await undo.click();
  await undo.click();
  const tempo = page.getByRole("spinbutton", { name: "Tempo (CPM)" });
  await tempo.fill("60");
  await tempo.press("Tab");
  await page.waitForFunction(() => (window as any).pdLiveFrame?.cps === 1);
  await undo.click();
  await page.locator('button[data-tab="audio"]').click();
  await drag(page, page.locator(".nd-audio-signals").getByText("Bass", { exact: true }), { x: graph.x + 240, y: graph.y + 508 });
  const fft = page.locator('[data-kind="fft"]');
  await fft.waitFor();
  await hoverTooltip(fft.getByRole("combobox", { name: "FFT band" }), /^Bass\n/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator('[data-kind="fft"]').count(), 0);

  const legacy = Buffer.from(JSON.stringify({ v: 1, code: '$: s("#aabbcc")', media: [] })).toString("base64url");
  await page.goto(url + "/?legacy#v1," + legacy);
  await page.locator(".cm-content").waitFor();
  assert.match(await page.locator(".cm-content").textContent() ?? "", /aabbcc/);
  assert.equal(await page.locator("#node-editor").isVisible(), false);
  await page.locator('button[data-tab="examples"]').click();
  for (const [example, kind] of [["rgb", "scroll"], ["picodevil", "position"]] as const) {
    await page.getByRole("button", { name: example, exact: true }).click();
    const axes = page.locator(`[data-kind="${kind}"]`);
    await axes.waitFor();
    assert.equal(await page.locator(".nd-status").textContent(), "Running");
    assert.equal(await page.locator(".cm-content").isVisible(), false);
    const x = await center(axes.locator('[data-input="x"]'));
    const y = await center(axes.locator('[data-input="y"]'));
    assert.equal(x.x, y.x);
    assert(y.y > x.y);
    assert.equal(await axes.locator(".nd-connected").count(), 3);
  }
  const rate = page.locator('[data-kind="signalRate"]').first();
  const rateMode = rate.getByRole("combobox", { name: "Mode" });
  const rateTitle = rate.locator(".nd-node-title");
  const connections = await rate.locator(".nd-connected").count();
  assert.equal(await rateMode.getAttribute("data-value"), "slow");
  await hoverTooltip(rateMode, /^Slow\nSlow a pattern down/);
  await rateTitle.press("Enter");
  assert.equal(await currentReference.textContent(), "slow()");
  await referenceTab.locator(".ref-search").fill("no reference matches this");
  await choose(rate, rateMode, "Fast");
  assert.equal(await rateMode.getAttribute("data-value"), "fast");
  await hoverTooltip(rateMode, /^Fast\nSpeed a pattern up/);
  await hoverTooltip(rateTitle, /Signal Rate · Fast/);
  await rateTitle.press("Enter");
  assert.equal(await currentReference.textContent(), "fast()");
  assert.equal(await referenceTab.locator(".ref-search").inputValue(), "");
  await referenceTab.locator("#ref-fast").evaluate(entry => {
    const pane = entry.closest(".ref-detail")!.getBoundingClientRect();
    const top = entry.getBoundingClientRect().top;
    if (top < pane.top || top > pane.top + 16) throw new Error("Reference did not scroll to the selected entry");
  });
  assert.equal(await rate.locator(".nd-connected").count(), connections);
  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("Slow Signal");
  await nodeResults.getByText("No matching nodes").waitFor();
  await cableSearch.press("Escape");

  const handwriting = page.locator('[data-kind="fontHandwriting"]');
  await hoverTooltip(handwriting.locator(".nd-node-title"), /Bounce, Informality, and Spacing in Shantell Sans/);
  assert.equal(await handwriting.locator(".nd-connected").count(), 3);
  assert.equal(await handwriting.locator('.nd-connected [data-input="BNCE"]').count(), 1);
  assert.equal(await handwriting.locator('.nd-connected [data-input="INFM"]').count(), 1);
  assert.equal(await handwriting.getByRole("spinbutton", { name: "Spacing" }).inputValue(), "");

  const italic = page.locator('[data-kind="fontItalic"]');
  const italicMode = italic.getByRole("combobox", { name: "Mode" });
  assert.equal(await italicMode.getAttribute("data-value"), "blend");
  assert.equal(await italic.locator('.nd-connected [data-input="ital"]').count(), 1);
  await choose(italic, italicMode, "On/Off");
  assert.equal(await italic.getByRole("checkbox", { name: "Italic" }).isChecked(), true);
  await choose(italic, italicMode, "Blend");
  assert.equal(await italic.locator('.nd-connected [data-input="ital"]').count(), 1);

  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("Font Width");
  await page.getByRole("button", { name: "Font Shape", exact: true }).click();
  const shape = page.locator('[data-kind="fontShape"]').last();
  assert.equal(await shape.locator('[data-input="image"]').getAttribute("data-type"), "textLayer");
  const shapeWeight = shape.getByRole("spinbutton", { name: "Weight" });
  const shapeHeight = shape.getByRole("spinbutton", { name: "Height" });
  assert.equal(await shapeWeight.inputValue(), "");
  await shapeWeight.fill("650");
  await shapeHeight.fill("1.25");
  assert.equal(await shapeWeight.inputValue(), "650");
  assert.equal(await shapeHeight.inputValue(), "1.25");
  assert.equal(await shape.getByRole("spinbutton", { name: "Width" }).inputValue(), "");

  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("Custom Font Axis");
  await page.getByRole("button", { name: "Custom Font Axis", exact: true }).click();
  const variation = page.locator('[data-kind="fontCustomAxis"]');
  const axisTag = variation.getByRole("textbox", { name: "Axis Tag" });
  await axisTag.fill("TEST");
  assert.equal(await variation.getByRole("spinbutton", { name: "Amount" }).inputValue(), "400");

  await page.getByRole("button", { name: "Variables", exact: true }).click();
  const variables = page.locator(".nd-variables");
  await variables.getByRole("textbox", { name: "Variable name" }).fill("Enabled");
  await choose(variables, variables.getByRole("combobox", { name: "Variable type" }), "Boolean");
  await variables.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add Node" }).click();
  const categoryColors = await page.locator(".nd-menu-category[data-category]").evaluateAll(headings =>
    headings.map(heading => getComputedStyle(heading).backgroundColor));
  assert.equal(categoryColors.length, 9);
  assert.equal(new Set(categoryColors).size, 9);
  assert.equal(await page.locator(".nd-menu-icon").count(), 9);
  assert.equal(await nodeResults.isVisible(), false);
  const signals = page.locator(".nd-menu-category[data-category=Signals]");
  const imageCategory = page.locator(".nd-menu-category[data-category=Image]");
  const signalsArrow = signals.locator(".nd-menu-arrow");
  await signalsArrow.hover();
  await page.waitForTimeout(240);
  assert.equal(await nodeResults.isVisible(), false);
  const signalsBox = await signals.boundingBox();
  const imageBox = await imageCategory.boundingBox();
  assert(signalsBox && imageBox);
  const rightSide = signalsBox.x + signalsBox.width * 0.85;
  const signalsY = signalsBox.y + signalsBox.height / 2;
  await page.mouse.move(rightSide, signalsY);
  assert.equal(await nodeResults.isVisible(), false);
  const waveform = nodeResults.getByRole("button", { name: "Waveform", exact: true });
  await waveform.hover();
  assert.equal(await signals.getAttribute("aria-expanded"), "true");
  const categoriesBox = await page.locator(".nd-menu-categories").boundingBox();
  const resultsBox = await nodeResults.boundingBox();
  assert(categoriesBox && resultsBox);
  assert(resultsBox.x >= categoriesBox.x + categoriesBox.width - 1);
  assert.equal(resultsBox.y, categoriesBox.y);
  await page.mouse.move(rightSide, signalsY);
  await page.mouse.move(rightSide, imageBox.y + imageBox.height / 2, { steps: 6 });
  await page.mouse.move(rightSide, signalsY, { steps: 6 });
  await page.waitForTimeout(240);
  assert.equal(await signals.getAttribute("aria-expanded"), "true");
  assert.equal(await imageCategory.getAttribute("aria-expanded"), "false");
  await imageCategory.hover();
  assert.equal(await signals.getAttribute("aria-expanded"), "false");
  assert.equal(await imageCategory.getAttribute("aria-expanded"), "true");
  assert.equal(await waveform.isVisible(), false);
  await signalsArrow.click();
  assert.equal(await signals.getAttribute("aria-expanded"), "true");
  await page.mouse.move(graph.x + graph.width - 20, graph.y + graph.height - 20);
  assert.equal(await nodeResults.isVisible(), false);

  await cableSearch.fill("brigthness");
  assert.equal(await nodeResults.getByRole("button").first().getAttribute("data-tooltip"), "Brightness");
  await cableSearch.fill("multiply");
  await nodeResults.getByRole("button", { name: "Multiply", exact: true }).waitFor();
  await nodeResults.getByRole("button", { name: "Blend · Multiply", exact: true }).waitFor();
  await cableSearch.fill("expression multiply");
  await nodeResults.getByRole("button", { name: "Multiply", exact: true }).waitFor();
  await page.locator(".nd-menu-category[data-category=Expressions]").click();
  const expressionOptions = nodeResults.getByRole("button", { name: /^(Add|Subtract|Multiply|Divide|Remainder|Minimum|Maximum)$/ });
  assert.deepEqual(await expressionOptions.allTextContents(), ["Add", "Subtract", "Multiply", "Divide", "Remainder", "Minimum", "Maximum"]);
  for (const [symbol, label] of [
    ["+", "Add"], ["-", "Subtract"], ["−", "Subtract"], ["×", "Multiply"],
    ["·", "Multiply"], ["⋅", "Multiply"], ["/", "Divide"], [":", "Divide"],
    ["÷", "Divide"], ["∶", "Divide"], ["%", "Remainder"], [" * ", "Multiply"],
  ]) {
    await cableSearch.fill(symbol);
    assert.equal(await nodeResults.getByRole("button").first().getAttribute("data-tooltip"), label);
  }
  await nodeResults.getByRole("button", { name: "Blend · Multiply", exact: true }).waitFor();
  await cableSearch.press("Enter");
  const expression = page.locator('[data-kind="expression"]');
  const expressionMode = expression.getByRole("combobox", { name: "Mode" });
  assert.equal(await expressionMode.getAttribute("data-value"), "multiply");
  await choose(expression, expressionMode, "Subtract");
  assert.equal(await expressionMode.getAttribute("data-value"), "subtract");
  await undo.click();
  await undo.click();
  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("modulo");
  await nodeResults.getByRole("button", { name: "Remainder", exact: true }).waitFor();
  await cableSearch.fill("float to boolean");
  await nodeResults.getByRole("button", { name: "Conversion · Float to Boolean", exact: true }).waitFor();
  await page.locator(".nd-menu-category[data-category=Expressions]").click();
  await nodeResults.getByRole("button", { name: "Conversion", exact: true }).click();
  const newConversion = page.locator('[data-kind="convert"]').last();
  assert.equal(await newConversion.locator('.nd-port:not([data-input=""])').getAttribute("data-type"), null);
  assert.equal(await newConversion.locator('[data-input=""]').getAttribute("data-type"), null);
  await undo.click();
  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("missing-node-name");
  await nodeResults.getByText("No matching nodes").waitFor();
  await cableSearch.clear();
  assert.equal(await nodeResults.isVisible(), false);
  await cableSearch.press("ArrowDown");
  assert.equal(await page.locator(".nd-menu-category:focus").count(), 1);
  await page.keyboard.press("ArrowRight");
  assert.equal(await nodeResults.locator("button:focus").count(), 1);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.locator(".nd-menu-category:focus").count(), 1);
  await cableSearch.fill("Set Variable");
  assert.equal(await nodeResults.getByRole("button").count(), 1);
  await nodeResults.getByRole("button", { name: "Variable", exact: true }).click();
  const variable = page.locator('[data-kind="variable"]');
  const variableTitle = variable.locator(".nd-node-title");
  assert.equal(await variableTitle.textContent(), "Get Enabled");
  const variablePicker = variable.getByRole("combobox", { name: "Variable" });
  assert.equal(await variablePicker.innerText(), "Enabled");
  const variableInput = page.getByRole("button", { name: "Variable Set Value (boolean)", exact: true });
  const variableOutput = page.getByRole("button", { name: "Variable Get Value output (boolean)", exact: true });
  assert.equal(await variable.locator(".nd-port-row").filter({ has: variableInput }).innerText(), "Set Value");
  assert.equal(await variable.locator(".nd-port-out").filter({ has: variableOutput }).innerText(), "Get Value");
  assert.equal(await variable.getByRole("checkbox").count(), 0);
  await variableInput.press("Enter");
  await cableSearch.fill("Constant");
  await nodeResults.getByRole("button", { name: "Constant · Boolean", exact: true }).click();
  assert.equal(await variableTitle.textContent(), "Set Enabled");
  await variableInput.dispatchEvent("contextmenu");
  assert.equal(await variableTitle.textContent(), "Get Enabled");
  assert.equal(await axisTag.inputValue(), "TEST");

  const portColors = await page.locator(".nd-port").evaluateAll(ports => ports.map(port => {
    const style = getComputedStyle(port);
    return [(port as HTMLElement).dataset.type, style.getPropertyValue("--nd-port-color").trim()];
  }));
  const palette = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(Object.entries({ visual: "visual", textLayer: "text", number: "number", text: "string", boolean: "boolean" })
      .map(([type, token]) => [type, style.getPropertyValue(`--nd-color-${token}`).trim()]));
  });
  for (const [type, color] of Object.entries(palette)) {
    assert(color);
    assert.deepEqual([...new Set(portColors.filter(([item]) => item === type).map(([, value]) => value))], [color]);
  }
  const numberWire = page.locator(".nd-wire-hit[data-type=number]").first();
  await numberWire.dispatchEvent("pointerdown", { button: 0 });
  const selectedWire = page.locator(".nd-wire-selected[data-type=number]:not(.nd-wire-hit)");
  assert.equal(await selectedWire.evaluate(path => getComputedStyle(path).stroke), await page.evaluate(color => {
    const sample = document.createElement("span");
    sample.style.color = color;
    return sample.style.color;
  }, palette.number));

  await page.evaluate(() => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    const graph = {
      nodes: [
        { id: "sample", kind: "screen", x: 40, y: 140, data: { pattern: "text:Hello" } },
        { id: "angle", kind: "fontAxis", x: 305, y: 140, data: { tag: "slnt", value: 0 } },
        { id: "output", kind: "output", x: 590, y: 140, data: {} },
      ],
      edges: [{ from: "sample", to: "angle", input: "image" }, { from: "angle", to: "output", input: "image" }],
      variables: [],
    };
    localStorage.setItem(key, JSON.stringify({ ...session, draft: graph, live: graph, view: { x: 0, y: 0, zoom: 1, previews: ["angle"] } }));
  });
  await page.goto(url);
  const angleCard = page.locator('[data-node-id="angle"]');
  const textPreview = angleCard.locator("canvas");
  await textPreview.waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-node-id="angle"] canvas')!;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return data.some((value, index) => index % 4 === 0 && value > 200);
  });
  const upright = await textPreview.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  const compareFrame = (snapshot: string, same: boolean) => page.waitForFunction(({ snapshot, same }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-node-id="angle"] canvas')!;
    return (canvas.toDataURL() === snapshot) === same;
  }, { snapshot, same });

  const slant = angleCard.getByRole("spinbutton", { name: "Angle (°)" });
  await slant.fill("20");
  await compareFrame(upright, false);
  const left = await textPreview.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  await slant.fill("-20");
  await compareFrame(left, false);
  await slant.fill("0");
  await compareFrame(upright, true);

  await page.evaluate(() => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    for (const graph of [session.draft, session.live]) {
      graph.nodes = graph.nodes.filter((node: { kind: string }) => node.kind !== "output");
      graph.edges = graph.edges.filter((edge: { to: string }) => edge.to !== "output");
    }
    localStorage.setItem(key, JSON.stringify(session));
  });
  await page.reload();
  await outputs.waitFor();
  assert.equal(await page.locator(".nd-node").count(), 3);
  assert.equal(await wires.count(), 1);

  const angleHeader = angleCard.locator("header");
  const recoveredOutputHeader = outputs.locator("header");
  const angleBounds = await angleHeader.boundingBox();
  assert(angleBounds);
  const headerY = angleBounds.y + angleBounds.height / 2;
  await drag(page, recoveredOutputHeader, { x: angleBounds.x + angleBounds.width, y: headerY });
  const overlap = { x: angleBounds.x + angleBounds.width * 0.75, y: headerY };
  const nodeAt = (point: { x: number; y: number }) => page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>(".nd-node")?.dataset.kind, point);
  assert.equal(await nodeAt(overlap), "output");
  await angleHeader.click({ position: { x: 4, y: 12 } });
  assert.equal(await nodeAt(overlap), "fontSlant");
  assert.equal(await nodeAt(await center(outputs.locator('[data-input="image"]'))), "fontSlant");

  await page.mouse.move(angleBounds.x + 4, headerY);
  await page.mouse.down();
  await page.mouse.move(angleBounds.x + 24, headerY, { steps: 8 });
  assert.equal(await nodeAt(overlap), "fontSlant");
  await page.mouse.up();
  assert.equal(await nodeAt(overlap), "fontSlant");

  await page.locator(".nd-viewport").click({ position: { x: 24, y: 24 } });
  assert.equal(await page.locator(".nd-node.is-selected").count(), 0);
  assert.equal(await nodeAt(overlap), "fontSlant");
  await angleCard.locator(".nd-preview-toggle").click();
  assert.equal(await nodeAt(overlap), "fontSlant");

  await recoveredOutputHeader.click({ position: { x: angleBounds.width - 4, y: 12 } });
  assert.equal(await nodeAt(overlap), "output");

  await page.evaluate(() => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    const graph = {
      nodes: [
        { id: "source", kind: "testCard", x: 40, y: 100, data: {} },
        { id: "effect", kind: "brightness", x: 205, y: 125, data: {} },
        { id: "output", kind: "output", x: 560, y: 100, data: {} },
        { id: "branch", kind: "output", x: 820, y: 100, data: {} },
      ],
      edges: [{ from: "source", to: "effect", input: "image" }, { from: "effect", to: "output", input: "image" }],
      variables: [],
    };
    localStorage.setItem(key, JSON.stringify({ ...session, draft: graph, live: graph, view: { x: 110, y: 75, zoom: 0.75, previews: [] } }));
  });
  await page.reload();
  const selectionViewport = await page.locator(".nd-viewport").boundingBox();
  assert(selectionViewport);
  const box = page.locator(".nd-selection-box");
  const selectedIds = () => page.locator(".nd-node.is-selected").evaluateAll(cards =>
    cards.map(card => card.getAttribute("data-node-id")));
  const positions = () => page.locator(".nd-node").evaluateAll(cards => cards.map(card => {
    const { left, top } = (card as HTMLElement).style;
    return [parseFloat(left), parseFloat(top)];
  }));
  const startSelection = async () => {
    await page.mouse.move(selectionViewport.x + 400, selectionViewport.y + 285);
    await page.mouse.down();
    await page.mouse.move(selectionViewport.x + 120, selectionViewport.y + 130, { steps: 12 });
    assert.equal(await box.isVisible(), true);
    assert.deepEqual(await selectedIds(), ["source", "effect"]);
  };
  await originalHeader.click({ position: { x: 4, y: 12 } });
  await startSelection();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await box.isVisible(), false);
  assert.deepEqual(await selectedIds(), ["output"]);
  await startSelection();
  await page.mouse.up();
  assert.equal(await box.isVisible(), false);
  assert.deepEqual(await selectedIds(), ["source", "effect"]);

  const sourceCard = page.locator('[data-node-id="source"]');
  const sourceHeader = sourceCard.locator("header");
  const effectHeader = page.locator('[data-node-id="effect"] header');
  const beforeAlign = await positions();
  const sourceWidth = await sourceCard.evaluate(card => (card as HTMLElement).offsetWidth);
  const aligned = [[40, 100], [40 + sourceWidth + 24, 100], [560, 100], [820, 100]];
  await sourceHeader.getByRole("button", { name: "Test Card reference" }).focus();
  await page.keyboard.press("q");
  assert.deepEqual(await positions(), aligned);
  assert.equal((await center(sourceHeader)).y, (await center(effectHeader)).y);
  assert.deepEqual(await selectedIds(), ["source", "effect"]);
  assert.equal(await wires.count(), 2);
  await page.keyboard.press("q");
  await page.keyboard.press("Control+z");
  assert.deepEqual(await positions(), beforeAlign);
  await page.keyboard.press("Control+Shift+z");
  assert.deepEqual(await positions(), aligned);
  await page.keyboard.press("Control+z");
  assert.deepEqual(await positions(), beforeAlign);

  const beforePan = await center(sourceHeader);
  await page.mouse.move(selectionViewport.x + 25, selectionViewport.y + 25);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(selectionViewport.x + 55, selectionViewport.y + 40, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  const afterPan = await center(sourceHeader);
  assert.deepEqual(afterPan, { x: beforePan.x + 30, y: beforePan.y + 15 });
  assert.deepEqual(await selectedIds(), ["source", "effect"]);
  const beforeMove = await positions();
  await drag(page, sourceHeader, { x: afterPan.x + 90, y: afterPan.y + 45 });
  assert.deepEqual(await positions(), [[160, 160], [325, 185], [560, 100], [820, 100]]);
  assert.equal(await wires.count(), 2);
  await page.keyboard.press("Control+z");
  assert.deepEqual(await positions(), beforeMove);

  await page.keyboard.press("Delete");
  assert.equal(await page.locator(".nd-node").count(), 2);
  assert.equal(await wires.count(), 0);
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator(".nd-node").count(), 4);
  assert.equal(await wires.count(), 2);

  await page.mouse.move(selectionViewport.x + 120, selectionViewport.y + 130);
  await page.mouse.down();
  await page.mouse.move(selectionViewport.x + 850, selectionViewport.y + 300, { steps: 12 });
  await page.mouse.up();
  assert.deepEqual(await selectedIds(), ["source", "effect", "output", "branch"]);
  await sourceHeader.click({ button: "right" });
  await page.getByRole("button", { name: "Delete selected nodes" }).click();
  assert.equal(await page.locator(".nd-node").count(), 1);
  assert.equal(await outputs.getAttribute("data-node-id"), "output");
  assert.equal(await wires.count(), 0);

  await page.evaluate(() => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    const graph = {
      nodes: [
        { id: "color", kind: "color", x: 40, y: 110, data: { color: { hex: "#ff0000", alpha: 0.5 } } },
        { id: "test-card", kind: "testCard", x: 40, y: 400, data: {} },
        { id: "ramp", kind: "colorRamp", x: 360, y: 110, data: { interpolation: "B-Spline" } },
        { id: "output", kind: "output", x: 720, y: 150, data: {} },
      ],
      edges: [{ from: "ramp", to: "output", input: "image" }],
      variables: [],
    };
    localStorage.setItem(key, JSON.stringify({ ...session, draft: graph, live: graph, view: { x: 0, y: 0, zoom: 1, previews: ["ramp"] } }));
  });
  await page.reload();
  const rampCard = page.locator('[data-kind="colorRamp"]');
  const sourceColor = page.locator('[data-node-id="color"]');
  const colorPorts = rampCard.locator('.nd-port[data-type="color"]');
  assert.equal(await rampCard.getAttribute("data-category"), "Image");
  assert.equal(await colorPorts.count(), 2);
  assert.equal(await rampCard.locator('[data-input="gradient"], [data-output="gradient"]').count(), 0);
  assert.equal(await rampCard.getByRole("combobox", { name: "Gradient color space" }).count(), 0);
  assert.equal(await rampCard.getByRole("combobox", { name: "Active color stop" }).count(), 0);
  assert.equal(await rampCard.getByRole("spinbutton", { name: "Position" }).count(), 0);
  const rampInterpolation = rampCard.getByRole("combobox", { name: "Gradient interpolation" });
  assert.deepEqual(await rampCard.locator('[role="option"]').allTextContents(), ["Linear", "Constant"]);
  assert.equal(await rampInterpolation.getAttribute("data-value"), "Linear");

  await rampCard.getByRole("button", { name: "Add color stop" }).click();
  assert.equal(await colorPorts.count(), 3);
  const added = await colorPorts.nth(1).getAttribute("data-input");
  assert(added);
  const stopHandle = rampCard.locator(`[data-ramp-stop="${added}"]`);
  const middlePort = rampCard.locator(`.nd-port[data-input="${added}"]`);
  await rampCard.getByRole("button", { name: "Color 2", exact: true }).click();
  const rampHex = rampCard.getByRole("textbox", { name: "Hex" });
  await rampHex.fill("#00ff0080");
  await rampHex.press("Enter");
  await page.keyboard.press("Escape");
  await choose(rampCard, rampInterpolation, "Constant");
  const strip = rampCard.locator(".nd-gradient-track canvas");
  await rampInterpolation.click();
  await rampCard.getByRole("option", { name: "Linear", exact: true }).hover();
  assert.notDeepEqual(await pixel(strip, 0.75, 0), [0, 255, 0, 128]);
  await rampInterpolation.press("Escape");
  assert.deepEqual(await pixel(strip, 0.75, 0), [0, 255, 0, 128]);
  await drag(page, sourceColor.locator('.nd-port[data-input=""]'), middlePort);
  assert.equal(await wires.filter({ visible: true }).count(), 2);
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-kind="colorRamp"] .nd-gradient-track canvas')!;
    return canvas.getContext("2d")!.getImageData(Math.floor(canvas.width * 0.75), 0, 1, 1).data[0] === 255;
  });
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-kind="colorRamp"] .nd-thumbnail')!;
    const [r, g, b, a] = canvas.getContext("2d")!.getImageData(Math.floor(canvas.width * 0.75), Math.floor(canvas.height * 0.5), 1, 1).data;
    return r >= 125 && g === 0 && b === 0 && Math.abs(a - 128) <= 1;
  });

  const imageInput = rampCard.locator('.nd-port[data-input="image"]');
  assert.equal(await imageInput.locator("xpath=..").locator("input").count(), 0);
  const rampImageSource = page.locator('[data-node-id="test-card"]');
  await drag(page, rampImageSource.locator('.nd-port-out .nd-port'), imageInput);
  assert.equal(await wires.filter({ visible: true }).count(), 3);
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-kind="colorRamp"] .nd-thumbnail')!;
    const [r, g, b, a] = canvas.getContext("2d")!.getImageData(Math.floor(canvas.width * 0.1), Math.floor(canvas.height * 0.25), 1, 1).data;
    return r >= 125 && g === 0 && b === 0 && Math.abs(a - 128) <= 1;
  });
  assert.deepEqual(await pixel(strip, 0.1, 0), [0, 0, 0, 255]);
  await imageInput.click({ button: "right" });
  assert.equal(await wires.filter({ visible: true }).count(), 2);

  const endStop = rampCard.locator('[data-ramp-stop="stop-end"]');
  const start = await center(endStop);
  await drag(page, endStop, { x: start.x - 145, y: start.y });
  assert.equal(await colorPorts.nth(2).getAttribute("data-input"), added);
  assert.equal(await wires.filter({ visible: true }).count(), 2);
  await page.reload();
  assert.equal(await colorPorts.nth(2).getAttribute("data-input"), added);
  assert.equal(await rampInterpolation.getAttribute("data-value"), "Constant");
  assert.equal(await wires.filter({ visible: true }).count(), 2);
  await stopHandle.focus();
  await rampCard.getByRole("button", { name: "Remove color stop" }).click();
  assert.equal(await colorPorts.count(), 2);
  assert.equal(await wires.filter({ visible: true }).count(), 1);
  const stripBounds = (await strip.boundingBox())!;
  await strip.dblclick({ position: { x: stripBounds.width * 0.75, y: stripBounds.height / 2 } });
  assert.equal(await colorPorts.count(), 3);
  assert.match(await rampCard.locator('.nd-gradient-stop[aria-pressed="true"]').getAttribute("aria-label") ?? "", /Color stop 3 at 0\.7/);

  await page.evaluate(() => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    session.draft.nodes.push(
      { id: "title", kind: "text", x: 40, y: 400, data: { content: "Color" } },
      { id: "style", kind: "textStyle", x: 360, y: 400, data: {} },
    );
    session.draft.edges.push({ from: "title", to: "style", input: "image" });
    localStorage.setItem(key, JSON.stringify(session));
  });
  await page.reload();
  const style = page.locator('[data-node-id="style"]');
  const colorSwatch = style.getByRole("button", { name: "Color", exact: true });
  await colorSwatch.click();
  const textColorPicker = style.getByRole("dialog", { name: "Color picker" });
  const hex = textColorPicker.getByRole("textbox", { name: "Hex" });
  await textColorPicker.getByRole("button", { name: "Use #00ff0080" }).click();
  assert.equal(await hex.inputValue(), "#00ff0080");
  const wheel = textColorPicker.getByRole("button", { name: "Color wheel" });
  const wheelBounds = (await wheel.boundingBox())!;
  await wheel.click({ position: { x: Math.floor(wheelBounds.width / 2), y: 8 } });
  assert.notEqual(await hex.inputValue(), "#00ff0080");
  assert((await hex.inputValue()).endsWith("80"));
  const alpha = textColorPicker.getByRole("slider", { name: "Alpha" });
  await alpha.fill("0.25");
  await hex.fill("#24c8a9");
  await hex.press("Enter");
  assert.equal(await hex.inputValue(), "#24c8a940");
  assert.equal(await alpha.inputValue(), "0.25");
  await colorSwatch.click();
  await textColorPicker.waitFor({ state: "hidden" });
  await page.reload();
  assert.equal(await colorSwatch.getAttribute("title"), "#24c8a940");
  await colorSwatch.click();
  await textColorPicker.getByRole("button", { name: "Clear color override" }).click();
  assert.equal(await colorSwatch.getAttribute("title"), "Inherit color");
  await drag(page, sourceColor.locator('.nd-port-out [data-type="color"]'), style.locator('[data-input="color"]'));
  assert.equal(await page.locator('.nd-wire-hit[data-type="color"]').count(), 1);
  assert.equal(await colorSwatch.count(), 0);

  const fitFixture = await page.evaluate(mediaUrl => {
    const session = JSON.parse(localStorage.getItem("nodesdevil-session-v1")!);
    const media = { id: "fit-blue-image", name: "fit-blue-image", url: mediaUrl, type: "image" };
    const graph = {
      nodes: [
        { id: "string", kind: "constant", x: 50, y: 200, data: { mode: "text", value: "add" } },
        { id: "overlay", kind: "testCard", x: 50, y: 390, data: {} },
        { id: "blend", kind: "blend", x: 320, y: 130, data: { mode: "screen multiply" } },
        { id: "fit", kind: "fit", x: 320, y: 330, data: {} },
        { id: "fit-media", kind: "media", x: 50, y: 610, data: { media: media.id } },
      ],
      edges: [{ from: "fit-media", to: "fit", input: "image" }],
      variables: [],
    };
    return JSON.stringify({ ...session, media: [...session.media, media], draft: graph, view: { x: 0, y: 0, zoom: 1, previews: ["fit"] } });
  }, url + "/test-assets/blue.png");
  // Seed on the next document so a late media update cannot overwrite the fixture during reload.
  await page.addInitScript(fixture => {
    if (sessionStorage.getItem("fit-test-seeded")) return;
    sessionStorage.setItem("fit-test-seeded", "true");
    localStorage.setItem("nodesdevil-session-v1", fixture);
  }, fitFixture);
  await page.reload();
  const blendCard = page.locator('[data-kind="blend"]');
  const blendMode = blendCard.getByRole("combobox", { name: "Mode", exact: true });
  const blendModePort = blendCard.locator('[data-input="mode"]');
  const overlayPort = blendCard.locator('[data-input="second"]');
  const fitCard = page.locator('[data-kind="fit"]');
  const fitMode = fitCard.getByRole("combobox", { name: "Mode", exact: true });
  const fitModePort = fitCard.locator('[data-input="mode"]');
  const fitPreview = fitCard.locator(".nd-thumbnail");
  const bluePixel = (rgba: number[]) => rgba[2] > 200 && rgba[3] === 255;
  const blankPixel = (rgba: number[]) => rgba[2] < 25;
  const savedSession = () => page.evaluate(() => localStorage.getItem("nodesdevil-session-v1"));
  assert.equal(await blendMode.getAttribute("data-value"), "screen multiply");
  assert.equal(await fitMode.getAttribute("data-value"), "cover");
  await waitPixel(fitPreview, bluePixel);
  await page.mouse.move(0, 0);
  const triggerStyles = await fitMode.evaluate(trigger => {
    const field = document.createElement("input");
    field.className = "nd-field";
    trigger.closest(".nd-node-body")!.append(field);
    const triggerStyle = getComputedStyle(trigger);
    const fieldStyle = getComputedStyle(field);
    const properties = ["backgroundColor", "borderTopColor", "color", "fontSize", "fontWeight"] as const;
    const styles = properties.map(property => [triggerStyle[property], fieldStyle[property]]);
    field.remove();
    return styles;
  });
  for (const [actual, expected] of triggerStyles) assert.equal(actual, expected);
  const beforeHover = await savedSession();
  await fitMode.click();
  const modeColor = await fitModePort.evaluate(port => getComputedStyle(port).backgroundColor);
  const check = fitCard.getByRole("option", { name: "cover", exact: true }).locator(".ph-check");
  assert.equal(await check.evaluate(icon => getComputedStyle(icon).color), modeColor);
  const contain = fitCard.getByRole("option", { name: "contain", exact: true });
  await contain.hover();
  assert.equal(await contain.evaluate(row => getComputedStyle(row).backgroundColor), modeColor);
  await waitPixel(fitPreview, blankPixel);
  await fitCard.getByRole("option", { name: "fill", exact: true }).hover();
  await waitPixel(fitPreview, bluePixel);
  await fitCard.getByRole("option", { name: "none", exact: true }).hover();
  await waitPixel(fitPreview, blankPixel);
  assert.equal(await savedSession(), beforeHover);
  assert.equal(await fitMode.getAttribute("data-value"), "cover");
  await fitPreview.hover();
  await waitPixel(fitPreview, bluePixel);
  await fitMode.press("ArrowDown");
  await waitPixel(fitPreview, blankPixel);
  await fitMode.press("Escape");
  await waitPixel(fitPreview, bluePixel);
  assert.equal(await savedSession(), beforeHover);
  await choose(fitCard, fitMode, "tilecenter");
  assert.equal(await fitMode.getAttribute("data-value"), "tilecenter");
  await undo.click();
  assert.equal(await fitMode.getAttribute("data-value"), "cover");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(await fitMode.getAttribute("data-value"), "tilecenter");
  await choose(blendCard, blendMode, "multiply");
  await drag(page, page.locator('[data-node-id="overlay"] .nd-port-out .nd-port'), overlayPort);
  assert.equal(await blendCard.locator('.nd-connected [data-input="second"]').count(), 1);
  await drag(page, page.locator('[data-node-id="string"] .nd-port-out .nd-port'), blendModePort);
  assert.equal(await blendMode.count(), 0);
  assert.equal(await page.locator('.nd-wire-hit[data-type="text"]').count(), 1);
  await page.reload();
  assert.equal(await fitMode.getAttribute("data-value"), "tilecenter");
  assert.equal(await blendMode.count(), 0);
  assert.equal(await blendCard.locator('.nd-connected [data-input="second"]').count(), 1);
  await blendModePort.click({ button: "right" });
  assert.equal(await blendMode.getAttribute("data-value"), "multiply");

  await page.evaluate(() => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    const draft = {
      nodes: [
        { id: "feed", kind: "testCard", x: 60, y: 100, data: {} },
        { id: "out-a", kind: "output", x: 650, y: 100, data: {} },
        { id: "out-b", kind: "output", x: 650, y: 360, data: {} },
      ],
      edges: [{ from: "feed", to: "out-a", input: "image" }],
      variables: [],
    };
    localStorage.setItem(key, JSON.stringify({ ...session, draft, view: { x: 0, y: 0, zoom: 1, previews: [] } }));
  });
  await page.reload();
  await page.waitForFunction(() => {
    const wire = document.querySelector(".nd-wire-hit");
    return wire && getComputedStyle(wire).pointerEvents === "stroke";
  });
  const wireMiddle = await wires.first().evaluate(wire => {
    const path = wire as SVGPathElement;
    const { x, y } = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    return { x, y };
  });
  await page.mouse.dblclick(wireMiddle.x, wireMiddle.y);
  const junction = page.locator('[data-kind="junction"]');
  const junctionHandle = junction.getByRole("button", { name: "Junction", exact: true });
  assert.equal(await junction.count(), 1);
  assert.equal(await wires.count(), 2);
  const outA = page.locator('[data-node-id="out-a"] [data-input="image"]');
  const outB = page.locator('[data-node-id="out-b"] [data-input="image"]');
  const feed = page.locator('[data-node-id="feed"] [data-input=""]');
  await drag(page, junction.locator('[data-input=""]'), outB);
  assert.equal(await wires.count(), 3);
  const movedJunction = { x: wireMiddle.x + 35, y: wireMiddle.y + 46 };
  await drag(page, junctionHandle, movedJunction);
  assert(Math.abs((await center(junctionHandle)).y - movedJunction.y) < 2);
  await run.click();
  assert.equal(await page.locator(".nd-status").textContent(), "Running");

  const looseInputs = page.getByRole("button", { name: "Loose input end", exact: true });
  const looseOutputs = page.getByRole("button", { name: "Loose output end", exact: true });
  for (const action of ["menu", "keyboard"]) {
    if (action === "menu") {
      await junctionHandle.click({ button: "right" });
      await page.getByRole("button", { name: "Delete junction", exact: true }).click();
    } else {
      await junctionHandle.click();
      await page.keyboard.press("Delete");
    }
    assert.equal(await junction.count(), 0);
    assert.equal(await wires.count(), 0);
    assert.equal(await looseInputs.count() + await looseOutputs.count(), 0);
    assert.equal(await feed.count() + await outA.count() + await outB.count(), 3);
    await undo.click();
    assert.equal(await junction.count(), 1);
    assert.equal(await wires.count(), 3);
  }

  await junctionHandle.click({ button: "right" });
  await page.getByRole("button", { name: "Delete junction and keep cable ends", exact: true }).click();
  assert.equal(await junction.count(), 0);
  assert.equal(await wires.count(), 3);
  assert.equal(await looseInputs.count(), 1);
  assert.equal(await looseOutputs.count(), 2);
  assert.equal(await page.locator('[data-kind="output"] .nd-connected').count(), 0);
  await undo.click();
  assert.equal(await junction.count(), 1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(await junction.count(), 0);
  const originalEnd = await center(looseOutputs.first());
  const otherEnd = await center(looseOutputs.last());
  const movedEnd = { x: originalEnd.x + 70, y: originalEnd.y + 60 };
  await drag(page, looseOutputs.first(), movedEnd);
  assert(Math.abs((await center(looseOutputs.first())).y - movedEnd.y) < 2);
  assert.deepEqual(await center(looseOutputs.last()), otherEnd);
  await page.reload();
  await looseOutputs.first().waitFor();
  assert.equal(await wires.count(), 3);
  assert(Math.abs((await center(looseOutputs.first())).y - movedEnd.y) < 2);
  await drag(page, looseInputs, outA);
  assert.equal(await looseInputs.count(), 0);
  assert.equal(await looseOutputs.count(), 1);
  await drag(page, looseOutputs, feed);
  assert.equal(await looseOutputs.count(), 0);
  assert.equal(await wires.count(), 2);
  await run.click();
  assert.equal(await page.locator(".nd-status").textContent(), "Running");

  await page.evaluate(() => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    const draft = {
      nodes: [
        { id: "mask-ramp", kind: "colorRamp", x: 40, y: 255, data: {} },
        { id: "mask-fill", kind: "color", x: 40, y: 75, data: { color: { hex: "#ff0000", alpha: 1 } } },
        { id: "mask-opacity", kind: "alpha", x: 630, y: 220, data: {} },
        { id: "mask-output", kind: "output", x: 980, y: 220, data: {} },
        { id: "mask-flag", kind: "variable", x: 950, y: 340, data: { variable: "mask-flag" } },
      ],
      edges: [
        { from: "mask-fill", to: "mask-opacity", input: "image" },
        { from: "mask-opacity", to: "mask-output", input: "image" },
      ],
      variables: [{ id: "mask-flag", name: "Mask Flag", type: "boolean" }],
    };
    localStorage.setItem(key, JSON.stringify({ ...session, draft, view: { x: 0, y: 0, zoom: 1, previews: ["mask-opacity"] } }));
  });
  await page.reload();
  const maskImage = page.locator('[data-node-id="mask-ramp"] .nd-port-out .nd-port').first();
  const maskedOpacity = page.locator('[data-node-id="mask-opacity"]');
  const maskAmount = maskedOpacity.locator('[data-input="value"]');
  await drag(page, maskImage, maskAmount);
  const hasImageConversion = async () => {
    const { draft } = JSON.parse((await savedSession())!);
    return draft.nodes.some((node: { kind: string; data: { mode?: string; automatic?: boolean } }) =>
      node.kind === "convert" && node.data.mode === "imageToFloat" && node.data.automatic);
  };
  assert(await hasImageConversion());
  await run.click();
  assert.equal(await page.locator(".nd-status").textContent(), "Running");
  const maskedPreview = maskedOpacity.locator(".nd-thumbnail");
  await waitPixel(maskedPreview, ([, , , a]) => a >= 4 && a <= 15);
  assert((await pixel(maskedPreview, 0.1, 0.5))[3] < 40);
  assert((await pixel(maskedPreview, 0.9, 0.5))[3] > 215);
  await page.reload();
  assert(await hasImageConversion());
  const imageConversion = page.locator('[data-kind="convert"]');
  const conversionId = await imageConversion.getAttribute("data-node-id");
  const conversionOutput = imageConversion.locator('[data-input=""]');
  await conversionOutput.click({ modifiers: ["Alt"] });
  assert.equal(await imageConversion.getAttribute("data-node-id"), conversionId);
  assert.equal(await imageConversion.locator('[data-input="image"]').getAttribute("data-type"), "visual");
  assert.equal(await conversionOutput.getAttribute("data-type"), null);
  await page.reload();
  assert.equal(await conversionOutput.getAttribute("data-type"), null);
  await drag(page, conversionOutput, page.locator('[data-node-id="mask-flag"] [data-input="value"]'));
  assert.equal(await imageConversion.getAttribute("data-node-id"), conversionId);
  assert.equal(await conversionOutput.getAttribute("data-type"), "boolean");
  const conversionInput = imageConversion.locator('.nd-port:not([data-input=""])');
  await conversionInput.click({ modifiers: ["Alt"] });
  assert.equal(await conversionInput.getAttribute("data-type"), null);
  assert.equal(await conversionOutput.getAttribute("data-type"), "boolean");
  await page.reload();
  assert.equal(await conversionInput.getAttribute("data-type"), null);
  await drag(page, page.locator('[data-node-id="mask-ramp"] [data-output="mask"]'), conversionInput);
  assert.equal(await imageConversion.getAttribute("data-node-id"), conversionId);
  assert.equal(await conversionInput.getAttribute("data-type"), "number");
  assert.equal(await conversionOutput.getAttribute("data-type"), "boolean");

  const textValue = `It's a "draft". C:\\media`;
  await page.evaluate(origin => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    const media = { id: "export-blue", name: "export-blue", url: `${origin}/test-assets/blue.png`, type: "image" };
    const output = { id: "export-output", kind: "output", x: 390, y: 100, data: {} };
    const edges = [{ from: "export-source", to: output.id, input: "image" }];
    const live = { nodes: [{ id: "export-source", kind: "color", x: 60, y: 100, data: { color: { hex: "#ff0000", alpha: 1 } } }, output], edges, variables: [] };
    const draft = {
      nodes: [
        { ...live.nodes[0], kind: "media", data: { media: media.id } },
        { id: "export-position", kind: "position", x: 390, y: 100, data: { x: 0.55, y: 0.45 } },
        { ...output, x: 700 },
        { id: "export-text", kind: "text", x: 390, y: 400, data: {} },
        { id: "export-text-position", kind: "position", x: 700, y: 400, data: { x: 0.2, y: 0.9 } },
        { ...output, id: "export-text-output", x: 1010, y: 400 },
      ],
      edges: [
        { from: "export-source", to: "export-position", input: "image" },
        { from: "export-position", to: output.id, input: "image" },
        { from: "export-text", to: "export-text-position", input: "image" },
        { from: "export-text-position", to: "export-text-output", input: "image" },
      ],
      variables: [],
    };
    const view = { x: 0, y: 0, zoom: 1, previews: [] };
    localStorage.setItem(key, JSON.stringify({ ...session, draft, live, media: [media], view }));
  }, url);
  await page.reload();
  const exportSource = page.locator('[data-node-id="export-source"]');
  const originalCard = (await exportSource.elementHandle())!;
  const originalWire = (await wires.first().elementHandle())!;
  const originalCurve = await originalWire.getAttribute("d");
  const exportTitle = await center(exportSource.locator(".nd-node-head"));
  await drag(page, exportSource.locator(".nd-node-head"), { x: exportTitle.x + 35, y: exportTitle.y + 50 });
  assert(await originalCard.evaluate(node => node.isConnected));
  assert(await originalWire.evaluate(node => node.isConnected));
  assert.notEqual(await originalWire.getAttribute("d"), originalCurve);
  await undo.click();
  assert.equal(await originalWire.getAttribute("d"), originalCurve);

  await page.getByRole("button", { name: "Add Node", exact: true }).click();
  await cableSearch.fill("Brightness");
  await nodeResults.getByRole("button", { name: "Brightness", exact: true }).click();
  const textContent = page.locator('[data-node-id="export-text"] input');
  await textContent.fill(textValue);
  assert(await originalCard.evaluate(node => node.isConnected));
  assert(await originalWire.evaluate(node => node.isConnected));

  const codeLines = page.locator("#editor-wrap .cm-line");
  await page.getByRole("button", { name: "Export Code", exact: true }).click();
  const code = (await codeLines.allTextContents()).join("\n");
  assert.match(code, /\$: s\("export-blue"\)\s+\.x\(0\.55\)\s+\.y\(0\.45\)/);
  assert.match(code, /\$: text\('/);
  assert.doesNotMatch(code, /nodeGraph|brightness/);

  const outputColor = async (target: Page, channel: number) => {
    await target.waitForFunction(channel => {
      const source = document.querySelector<HTMLCanvasElement>("#c")!;
      (window as any).pdRenderAt(0, 0.5);
      const sample = document.createElement("canvas");
      sample.width = sample.height = 1;
      const ctx = sample.getContext("2d")!;
      ctx.drawImage(source, source.width / 2, source.height / 2, 1, 1, 0, 0, 1, 1);
      const pixels = ctx.getImageData(0, 0, 1, 1).data;
      return pixels[channel] > 220 && pixels[2 - channel] < 30;
    }, channel);
  };
  await outputColor(page, 0);
  await page.waitForFunction(() => location.hash.startsWith("#v1,"));
  const paste = await browser.newPage();
  try {
    await paste.goto(url);
    await paste.locator(".nd-node").first().waitFor();
    await paste.evaluate(code => window.pdSetCode(code, true), code);
    await outputColor(paste, 2);
    await paste.goto(page.url());
    await paste.reload();
    await outputColor(paste, 2);
  } finally {
    await paste.close();
  }
  await page.getByRole("button", { name: "Nodes", exact: true }).click();
  await textContent.fill("Latest draft");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  assert.equal((await codeLines.allTextContents()).join("\n"), code);
  await page.getByRole("button", { name: "Nodes", exact: true }).click();
  await page.getByRole("button", { name: "Export Code", exact: true }).click();
  assert.match((await codeLines.allTextContents()).join("\n"), /Latest draft/);

  const spaceTv = examples.find(example => example.name === "space_tv")!;
  const examplePage = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    await examplePage.route("**/videoclip.picodevil.com/sources.json", route => route.fulfill({ json: [] }));
    await examplePage.goto(url);
    await examplePage.locator(".nd-node").first().waitFor();
    await seedMedia(examplePage, spaceTv.media!.map(name => ({ name, url: `${url}/test-assets/${name === "scanlines" ? "blue.png" : "red.png"}` })));
    const toggle = examplePage.locator("#sidebar-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await examplePage.locator('button[data-tab="examples"]').click();
    await examplePage.getByRole("button", { name: "space_tv", exact: true }).click();
    await examplePage.getByRole("button", { name: "Export Code", exact: true }).click();
    const exported = (await examplePage.locator("#editor-wrap .cm-line").allTextContents()).join("\n");
    assert.match(exported, /\$: s\("#222"\)[\s\S]*Hscan:[\s\S]*\.rows\(3\)\s+\.cols\(4\)\s+\.gridMod\(\)/);
    await examplePage.keyboard.press("Control+Enter");
    await examplePage.setViewportSize({ width: 360, height: 240 });
    const frame = { cycle: 0.25, cps: 0.5, settleMs: 450 };
    const rendered = await renderAndSettle(examplePage, frame);
    assert(rendered.settled);
    assert(rendered.pixels.data.some((value, i) => i % 4 === 0 && value > 90), "The exported grid must be visible above #222");
    await examplePage.evaluate(code => window.pdSetCode(code, true), spaceTv.code);
    const reference = await renderAndSettle(examplePage, frame);
    assert(reference.settled);
    assert.equal(diffPixels(rendered.pixels, reference.pixels, 0).drifted, 0);
  } finally {
    await examplePage.close();
  }

  assert.deepEqual(errors, []);
  console.log("NodesDevil browser check passed: node and cable gestures, live previews, projection, persistence, node controls, and on-demand code export.");
} finally {
  await close();
}
