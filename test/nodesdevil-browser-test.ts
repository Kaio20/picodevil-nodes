import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { seedMedia, startHarness } from "./harness";

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

const { page, url, close } = await startHarness({
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
  const source = page.locator('[data-kind="media"]');
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
  assert.equal(await nodeResults.getByRole("button", { name: "Output", exact: true }).count(), 0);
  await cableSearch.press("Escape");

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
  assert.equal(await branchOutput.getByRole("combobox", { name: "Layer order" }).inputValue(), "1");
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
  const corner = page.getByRole("button", { name: "Top left" });
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
  await hoverTooltip(source.getByRole("combobox", { name: "Media" }), /^nodes-red-renamed\nVideo$/);
  const mediaRow = page.locator(".vid-row").filter({ has: page.locator('[title=\'Insert "nodes-red-renamed"\']') });
  await drag(page, mediaRow.locator(".vid-thumb"), { x: graph.x + 210, y: graph.y + 570 });
  assert.equal(await source.count(), 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await source.count(), 1);
  await page.reload();
  await source.getByRole("button", { name: "Preview nodes-red-renamed" }).waitFor();
  assert.equal(await page.locator(".nd-node").count(), 5);
  assert.equal(await page.locator(".nd-preview").count(), 4);
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
  assert.equal(await rateMode.inputValue(), "slow");
  await hoverTooltip(rateMode, /^Slow\nSlow a pattern down/);
  await rateTitle.press("Enter");
  assert.equal(await currentReference.textContent(), "slow()");
  await referenceTab.locator(".ref-search").fill("no reference matches this");
  await rateMode.selectOption("fast");
  assert.equal(await rateMode.inputValue(), "fast");
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
  await page.getByRole("button", { name: "Signal Rate · Slow", exact: true }).click();
  assert.equal(await page.locator('[data-kind="signalRate"]').last().getByRole("combobox", { name: "Mode" }).inputValue(), "slow");

  const variations = page.locator('[data-kind="fontAxis"]');
  const exampleAxis = variations.first().getByRole("combobox", { name: "Font axis" });
  assert.equal(await exampleAxis.locator("option:checked").textContent(), "Informality");
  const axisCables = await variations.first().locator(".nd-connected").count();
  await exampleAxis.selectOption({ label: "Spacing" });
  assert.equal(await exampleAxis.inputValue(), "SPAC");
  assert.equal(await variations.first().locator(".nd-connected").count(), axisCables);

  await page.getByRole("button", { name: "Add Node" }).click();
  await cableSearch.fill("Font Axis");
  await page.getByRole("button", { name: "Font Variation", exact: true }).click();
  const variation = variations.last();
  const picker = variation.getByRole("combobox", { name: "Font axis" });
  const amount = variation.getByRole("spinbutton", { name: "Amount" });
  assert.equal(await amount.inputValue(), "400");
  const height = (await variation.boundingBox())!.height;
  await picker.selectOption({ label: "Bounce" });
  assert.doesNotMatch(await variation.innerText(), /Shantell Sans/);
  await hoverTooltip(picker, /^Bounce\nOpenType axis: BNCE\nUse a font like Shantell Sans\./);
  assert.equal((await variation.boundingBox())!.height, height);
  await picker.selectOption({ label: "Width" });
  assert.equal(await amount.inputValue(), "100");
  await hoverTooltip(picker, /^Width\nOpenType axis: wdth\nUse a font like /);
  assert.doesNotMatch(await tooltip.innerText(), /Shantell Sans/);
  await picker.selectOption({ label: "Custom tag…" });
  const axisTag = variation.getByRole("textbox", { name: "Custom axis tag" });
  assert.equal(await axisTag.evaluate(input => document.activeElement === input), true);
  await axisTag.fill("TEST");
  await axisTag.press("Tab");
  await hoverTooltip(picker, /OpenType axis: TEST/);

  await page.getByRole("button", { name: "Variables", exact: true }).click();
  const variables = page.locator(".nd-variables");
  await variables.getByRole("textbox", { name: "Variable name" }).fill("Enabled");
  await variables.getByRole("combobox", { name: "Variable type" }).selectOption("boolean");
  await variables.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add Node" }).click();
  const categoryColors = await page.locator(".nd-menu-category[data-category]").evaluateAll(headings =>
    headings.map(heading => getComputedStyle(heading).backgroundColor));
  assert.equal(categoryColors.length, 7);
  assert.equal(new Set(categoryColors).size, 7);
  assert.equal(await page.locator(".nd-menu-icon").count(), 7);
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
  await cableSearch.fill("enabled set");
  await page.getByRole("button", { name: "Set Enabled", exact: true }).click();
  assert.equal(await axisTag.inputValue(), "TEST");

  const portColors = await page.locator(".nd-port").evaluateAll(ports => ports.map(port => {
    const style = getComputedStyle(port);
    return [(port as HTMLElement).dataset.type, style.getPropertyValue("--nd-port-color").trim()];
  }));
  for (const [type, color] of Object.entries({ visual: "#2ce8f5", textLayer: "#b55088", number: "#63c74d", text: "#ff67bb", boolean: "#ff0044" })) {
    assert.deepEqual([...new Set(portColors.filter(([item]) => item === type).map(([, value]) => value))], [color]);
  }
  const numberWire = page.locator(".nd-wire-hit[data-type=number]").first();
  await numberWire.dispatchEvent("pointerdown", { button: 0 });
  const selectedWire = page.locator(".nd-wire-selected[data-type=number]:not(.nd-wire-hit)");
  assert.equal(await selectedWire.evaluate(path => getComputedStyle(path).stroke), "rgb(99, 199, 77)");

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

  await angleCard.getByRole("combobox", { name: "Font axis" }).selectOption({ label: "Italic On/Off" });
  const italicToggle = angleCard.getByRole("checkbox", { name: "Italic" });
  assert.equal(await italicToggle.isChecked(), true);
  assert.equal(await angleCard.locator('[data-input="enabled"]').getAttribute("data-type"), "boolean");
  await compareFrame(upright, false);
  await italicToggle.uncheck();
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
  assert.equal(await nodeAt(overlap), "fontAxis");
  assert.equal(await nodeAt(await center(outputs.locator('[data-input="image"]'))), "fontAxis");

  await page.mouse.move(angleBounds.x + 4, headerY);
  await page.mouse.down();
  await page.mouse.move(angleBounds.x + 24, headerY, { steps: 8 });
  assert.equal(await nodeAt(overlap), "fontAxis");
  await page.mouse.up();
  assert.equal(await nodeAt(overlap), "fontAxis");

  await page.locator(".nd-viewport").click({ position: { x: 24, y: 24 } });
  assert.equal(await page.locator(".nd-node.is-selected").count(), 0);
  assert.equal(await nodeAt(overlap), "fontAxis");
  await angleCard.locator(".nd-preview-toggle").click();
  assert.equal(await nodeAt(overlap), "fontAxis");

  await recoveredOutputHeader.click({ position: { x: angleBounds.width - 4, y: 12 } });
  assert.equal(await nodeAt(overlap), "output");

  await page.evaluate(() => {
    const key = "nodesdevil-session-v1";
    const session = JSON.parse(localStorage.getItem(key)!);
    const graph = {
      nodes: [
        { id: "source", kind: "testCard", x: 40, y: 100, data: {} },
        { id: "effect", kind: "brightness", x: 290, y: 100, data: {} },
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

  const sourceHeader = page.locator('[data-node-id="source"] header');
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
  assert.deepEqual(await positions(), [[160, 160], [410, 160], [560, 100], [820, 100]]);
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
        { id: "ramp", kind: "colorRamp", x: 40, y: 110, data: {} },
        { id: "gradient", kind: "gradientImage", x: 580, y: 110, data: {} },
        { id: "output", kind: "output", x: 900, y: 110, data: {} },
        { id: "set", kind: "set", x: 350, y: 110, data: {} },
        { id: "get", kind: "get", x: 350, y: 260, data: {} },
      ],
      edges: [{ from: "gradient", to: "output", input: "image" }],
      variables: [],
    };
    localStorage.setItem(key, JSON.stringify({ ...session, draft: graph, live: graph, view: { x: 0, y: 0, zoom: 1, previews: ["gradient"] } }));
  });
  await page.reload();
  const rampCard = page.locator('[data-kind="colorRamp"]');
  const setter = page.locator('[data-kind="set"]');
  const getter = page.locator('[data-kind="get"]');
  const gradientImage = page.locator('[data-kind="gradientImage"]');
  await rampCard.getByRole("button", { name: "Add color stop" }).click();
  const stop = rampCard.getByRole("button", { name: /^Color stop 2 at/ });
  const start = await center(stop);
  await drag(page, stop, { x: start.x + 36, y: start.y });
  const position = +await rampCard.getByRole("spinbutton", { name: "Position" }).inputValue();
  assert(position > 0.6 && position < 0.8);
  await rampCard.getByLabel("Color", { exact: true }).fill("#ff0000");
  await rampCard.getByRole("spinbutton", { name: "Alpha" }).fill("0.5");
  await rampCard.getByRole("combobox", { name: "Gradient interpolation" }).selectOption("Constant");

  await page.getByRole("button", { name: "Variables", exact: true }).click();
  await variables.getByRole("textbox", { name: "Variable name" }).fill("Palette");
  await variables.getByRole("combobox", { name: "Variable type" }).selectOption("gradient");
  await variables.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  for (const card of [setter, getter]) await card.getByRole("combobox", { name: "Variable" }).selectOption({ label: "Palette" });
  assert.equal(await setter.getByRole("group", { name: "Gradient editor" }).count(), 1);
  await drag(page, rampCard.locator('[data-output="gradient"]'), setter.locator('[data-input="value"]'));
  await drag(page, getter.locator('[data-input=""]'), gradientImage.locator('[data-input="gradient"]'));
  assert.equal(await wires.filter({ visible: true }).count(), 3);
  assert.equal(await setter.getByRole("group", { name: "Gradient editor" }).count(), 0);
  const imagePreview = gradientImage.locator(".nd-thumbnail");
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-kind="gradientImage"] .nd-thumbnail')!;
    const [r, g, b, a] = canvas.getContext("2d")!.getImageData(Math.floor(canvas.width * 0.85), Math.floor(canvas.height / 2), 1, 1).data;
    return r > 200 && g < 20 && b < 20 && a >= 126 && a <= 129;
  });
  assert.equal((await pixel(imagePreview, 0.15, 0.5))[0], 0);
  await page.reload();
  assert.equal(await page.locator('.nd-wire-hit[data-type="gradient"]').count(), 2);
  assert.equal(await rampCard.getByRole("combobox", { name: "Gradient interpolation" }).inputValue(), "Constant");
  assert.equal(await rampCard.getByRole("button", { name: `Color stop 2 at ${position}` }).count(), 1);

  assert.deepEqual(errors, []);
  console.log("NodesDevil browser check passed: box selection, two-column node menu and search, numeric input and cable gestures, font controls, media drag, previews, projection, persistence, examples, palette, and gradient variables.");
} finally {
  await close();
}
