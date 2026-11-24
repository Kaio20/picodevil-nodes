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
  await drag(page, clip, outputInput);
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
    if (cancel) await page.keyboard.press("Escape");
    else await page.mouse.move(sourceCenter.x, sourceCenter.y, { steps: 8 });
    await page.mouse.up();
    assert.equal(await wires.count(), 1);
  }

  await drag(page, sourceOutput, blank);
  await cableSearch.waitFor();
  assert.equal(await wires.count(), 1);
  await page.mouse.click(graph.x + 90, graph.y + 475);
  assert.equal(await wires.count(), 0);
  assert.equal(await cableSearch.isVisible(), false);
  await drag(page, sourceOutput, blank);
  const nodeResults = page.locator(".nd-menu-results");
  await page.locator(".nd-menu-category").first().waitFor();
  assert.equal(await nodeResults.isVisible(), false);
  await page.locator('.nd-menu-category[data-category="Image"]').hover();
  await nodeResults.getByRole("button", { name: "Hue Rotate", exact: true }).waitFor();
  await cableSearch.hover();
  assert.equal(await nodeResults.isVisible(), false);
  await cableSearch.fill("rot hue");
  assert.equal(await nodeResults.getByRole("button").first().getAttribute("title"), "Hue Rotate");
  await page.getByRole("button", { name: "Hue Rotate", exact: true }).click();
  const hue = page.locator('[data-kind="hue"]');
  await drag(page, sourceOutput, outputInput);
  assert.equal(await wires.count(), 2);
  await drag(page, sourceOutput, cardOutput);
  assert.equal(await wires.count(), 2);
  assert.match(await cardOutput.getAttribute("title") ?? "", /Alt-click/);
  assert.doesNotMatch(await sourceOutput.getAttribute("title") ?? "", /Alt-click/);
  await cardOutput.click({ modifiers: ["Alt"] });
  assert.equal(await wires.count(), 0);
  await undo.click();
  await undo.click();
  assert.equal(await wires.count(), 2);
  assert.match(await sourceOutput.getAttribute("title") ?? "", /Alt-click/);
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
    const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await drag(page, brightness.locator("header"), wireMidpoint);
  assert.equal(await page.locator(".nd-wire-hit").count(), 4);
  await brightness.locator("header").click({ button: "right" });
  await page.getByRole("button", { name: "Detach from chain" }).click();
  assert.equal(await page.locator(".nd-wire-hit").count(), 3);
  await brightness.locator("header").click({ button: "right" });
  await page.getByRole("button", { name: "Delete node" }).click();

  await hue.getByRole("spinbutton", { name: "Turns" }).fill("0.6");
  await hue.getByRole("spinbutton", { name: "Turns" }).press("Tab");
  const secondHue = await waitPixel(hue.locator("canvas"), rgba => rgba[3] === 255 && rgba.slice(0,3).some((channel, i) => Math.abs(channel - firstHue[i]) > 35));
  await waitPixel(grid.locator("canvas"), rgba => rgba[3] === 255 && rgba.slice(0,3).every((channel, i) => Math.abs(channel - secondHue[i]) < 15));
  assert.deepEqual(await pixel(stage), testCard);
  await drag(page, grid.locator('[data-input=""]'), outputInput);
  await page.getByRole("button", { name: /Run/ }).click();
  await waitPixel(stage, rgba => rgba.slice(0,3).every((channel, i) => Math.abs(channel - secondHue[i]) < 15));

  await projection.click();
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

  await page.locator('[title="Switch to edit view"]').click();
  const name = page.locator(".vid-row").filter({ has: page.locator('input.vid-name') }).locator('input.vid-name');
  const names = await name.all();
  for (const item of names) {
    if (await item.inputValue() !== "nodes-red") continue;
    await item.fill("nodes-red-renamed");
    await item.press("Tab");
    break;
  }
  await source.getByRole("button", { name: "Preview nodes-red-renamed" }).waitFor();
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
  await page.locator('[data-kind="fft"]').waitFor();
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
  const connections = await rate.locator(".nd-connected").count();
  assert.equal(await rateMode.inputValue(), "slow");
  await rateMode.selectOption("fast");
  assert.equal(await rateMode.inputValue(), "fast");
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
  await picker.selectOption({ label: "Width" });
  assert.equal(await amount.inputValue(), "100");
  await picker.selectOption({ label: "Custom tag…" });
  const axisTag = variation.getByRole("textbox", { name: "Custom axis tag" });
  assert.equal(await axisTag.evaluate(input => document.activeElement === input), true);
  await axisTag.fill("TEST");
  await axisTag.press("Tab");

  await page.getByRole("button", { name: "Variables", exact: true }).click();
  const variables = page.locator(".nd-variables");
  await variables.getByRole("textbox", { name: "Variable name" }).fill("Enabled");
  await variables.getByRole("combobox", { name: "Variable type" }).selectOption("boolean");
  await variables.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add Node" }).click();
  const categoryColors = await page.locator(".nd-menu-category[data-category]").evaluateAll(headings =>
    headings.map(heading => getComputedStyle(heading).backgroundColor));
  assert.equal(categoryColors.length, 8);
  assert.equal(new Set(categoryColors).size, 8);
  assert.equal(await page.locator(".nd-menu-icon").count(), 8);
  assert.equal(await nodeResults.isVisible(), false);
  const signals = page.locator(".nd-menu-category[data-category=Signals]");
  await signals.hover();
  const waveform = nodeResults.getByRole("button", { name: "Waveform", exact: true });
  await waveform.hover();
  assert.equal(await signals.getAttribute("aria-expanded"), "true");
  const categoriesBox = await page.locator(".nd-menu-categories").boundingBox();
  const resultsBox = await nodeResults.boundingBox();
  assert(categoriesBox && resultsBox);
  assert(resultsBox.x >= categoriesBox.x + categoriesBox.width - 1);
  assert.equal(resultsBox.y, categoriesBox.y);
  const imageCategory = page.locator(".nd-menu-category[data-category=Image]");
  await imageCategory.hover();
  assert.equal(await signals.getAttribute("aria-expanded"), "false");
  assert.equal(await imageCategory.getAttribute("aria-expanded"), "true");
  assert.equal(await waveform.isVisible(), false);
  await page.mouse.move(graph.x + graph.width - 20, graph.y + graph.height - 20);
  assert.equal(await nodeResults.isVisible(), false);

  await cableSearch.fill("brigthness");
  assert.equal(await nodeResults.getByRole("button").first().getAttribute("title"), "Brightness");
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
  for (const [type, color] of Object.entries({ visual: "#2ce8f5", number: "#63c74d", text: "#fee761", boolean: "#ff0044" })) {
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

  assert.deepEqual(errors, []);
  console.log("NodesDevil browser check passed: two-column node menu and search, cable gestures, font controls, media drag, previews, projection, persistence, examples, and palette.");
} finally {
  await close();
}
