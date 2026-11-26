import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compile } from "../src/compositor/compiler";
import { connect, example, makeNode, type Project } from "../src/compositor/graph";

const origin = process.env.COMPOSITOR_URL ?? "http://localhost:5173";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu"] });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "/compositor/");
  await page.waitForFunction(() => (window as any).compositor?.state().draftReady);
  assert.equal(await page.locator("#wires g").count(), 9);
  assert.match(await page.getByRole("button", { name: "Merge Factor input" }).getAttribute("title") ?? "", /luminance/);
  const clocks = await page.evaluate(() => (window as any).compositor.state().time);
  assert.ok(clocks.seconds > 0);

  const [output] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open Output", exact: true }).click(),
  ]);
  await page.getByRole("button", { name: "Take", exact: true }).click();
  await page.waitForFunction(() => (window as any).compositor.state().takes === 120);
  await output.locator("canvas").waitFor();
  const preview = await output.locator("canvas").screenshot({ type: "png", scale: "css" });
  const hasColor = await output.evaluate(async data => {
    const image = new Image();
    image.src = data;
    await image.decode();
    const check = document.createElement("canvas");
    check.width = 12;
    check.height = 8;
    const context = check.getContext("2d")!;
    context.drawImage(image, 0, 0, 12, 8);
    return context.getImageData(0, 0, 12, 8).data.some((value, index) => index % 4 !== 3 && value > 20);
  }, `data:image/png;base64,${preview.toString("base64")}`);
  assert.ok(hasColor, "The projection did not present any colored pixels.");

  await page.getByRole("spinbutton", { name: "BPM" }).fill("136");
  await page.getByRole("spinbutton", { name: "BPM" }).press("Tab");
  await page.waitForFunction(() => {
    const state = (window as any).compositor.state();
    return state.draftReady && state.draftBpm === 136 && state.previewTime.beats - state.time.beats > 0.02;
  });
  const before = await page.evaluate(() => (window as any).compositor.state());
  assert.equal(before.takes, 120, "BPM edits must remain in Preview until Take.");
  await page.getByRole("button", { name: "Take", exact: true }).click();
  await page.waitForFunction(() => (window as any).compositor.state().takes === 136);
  const after = await page.evaluate(() => (window as any).compositor.state());
  assert.ok(after.time.beats >= before.time.beats && after.time.beats - before.time.beats < 2);
  for (const asset of ["demo-a", "demo-b"]) {
    const elapsed = (after.clips[asset] - before.clips[asset] + 4) % 4;
    assert.ok(elapsed < 1, `${asset} playback jumped by ${elapsed}s during Take.`);
  }

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "Project saved in this browser.");
  await page.getByRole("button", { name: "Add Node" }).click();
  await page.getByRole("searchbox", { name: "Add Node" }).fill("Custom Expression");
  await page.getByRole("searchbox", { name: "Add Node" }).press("Enter");
  await page.getByRole("textbox", { name: "WGSL expression" }).fill("sin(a, b)");
  await page.locator('[data-node][data-error="true"]').waitFor();
  assert.notEqual(await page.getByRole("alert").textContent(), "");

  const base = example();
  const invalidExpression = makeNode("expression", 430, 20, "invalid", { code: "sin(a, b)" });
  const invalid = connect({ ...base, bpm: 90, nodes: [...base.nodes, invalidExpression] },
    { from: invalidExpression.id, to: "merge", input: "factor" });
  await page.evaluate(graph => (window as any).compositor.load(graph), invalid);
  await page.waitForFunction(() => Boolean((window as any).compositor.state().error));
  assert.equal(await page.getByRole("button", { name: "Take", exact: true }).isDisabled(), true);
  await page.keyboard.press("Control+Enter");
  assert.equal(await page.evaluate(() => (window as any).compositor.state().takes), 136);
  assert.equal(await output.isClosed(), false);

  await page.getByRole("button", { name: "Open saved" }).click();
  await page.waitForFunction(() => (window as any).compositor.state().draftReady);
  assert.equal(await page.getByRole("spinbutton", { name: "BPM" }).inputValue(), "136");
  await page.locator("#files").setInputFiles(fileURLToPath(new URL("../public/compositor-media/spectrum.mp4", import.meta.url)));
  const asset = page.getByRole("button", { name: "spectrum.mp4 Video", exact: true });
  await asset.waitFor();
  await asset.dragTo(page.locator("#graph"), { targetPosition: { x: 55, y: 60 } });
  await page.getByText("spectrum.mp4", { exact: true }).filter({ visible: true }).last().waitFor();
  assert.equal(await page.locator('[data-group="Media"].node').count(), 3);

  const cableBoard = { ...example(), nodes: [...example().nodes, makeNode("lfo", 820, 404, "lfo")] };
  assert.throws(() => connect(cableBoard, { from: "noise", to: "lfo", input: "rate" }), /single value/);
  assert.throws(() => connect(cableBoard, { from: "merge", to: "merge", input: "foreground" }), /cycle/);
  await page.evaluate(graph => (window as any).compositor.load(graph), {
    ...base, nodes: [...base.nodes, makeNode("mask", 785, 385, "wire-test")],
  });
  const outlet = await page.getByRole("button", { name: "Noise Float output" }).boundingBox();
  const inlet = await page.getByRole("button", { name: "Apply Mask Mask input" }).boundingBox();
  assert.ok(outlet && inlet);
  await page.mouse.move(outlet.x + outlet.width / 2, outlet.y + outlet.height / 2);
  await page.mouse.down();
  await page.mouse.move(inlet.x + inlet.width / 2, inlet.y + inlet.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.locator("#wires g").count(), 10);

  const source = makeNode("color", 0, 0, "fg", { color: "#ff0000", alpha: 0.5 });
  const blue = makeNode("color", 0, 0, "bg", { color: "#0000ff" });
  const video = makeNode("video", 0, 0, "video");
  const testPlan = (items: Project["nodes"], edges: Project["edges"], root: string) => compile({ version: 1, bpm: 120, nodes: items, edges }, root);
  const plans = [
    testPlan([source, blue, makeNode("merge", 0, 0, "merge", { "input:factor": 0.5 })], [
      { from: "fg", to: "merge", input: "foreground" }, { from: "bg", to: "merge", input: "background" },
    ], "merge"),
    testPlan([source, makeNode("mask", 0, 0, "mask", { "input:mask": 0.5 })], [{ from: "fg", to: "mask", input: "image" }], "mask"),
    testPlan([video, makeNode("displace", 0, 0, "displace", { "input:offset": 0.5, "input:strength": 1 })], [
      { from: "video", to: "displace", input: "image" },
    ], "displace"),
    testPlan([makeNode("value", 0, 0, "float"), makeNode("switch", 0, 0, "switch", { "input:active": 0.5 }),
      makeNode("mixColor", 0, 0, "mix", { "input:factor": 0 })], [
      { from: "float", to: "switch", input: "condition" }, { from: "switch", to: "mix", input: "a" },
    ], "mix"),
  ];
  const samples = await page.evaluate(async ({ module, plans }) => {
    const { Renderer } = await import(module);
    const gpu = await Renderer.create();
    const input = gpu.texture(2, 1);
    gpu.device.queue.writeTexture({ texture: input }, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), { bytesPerRow: 8 }, [2, 1]);
    const values: number[][] = [];
    for (const plan of plans) {
      const program = await gpu.prepare(plan, 2, 1);
      const buffer = gpu.device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = gpu.device.createCommandEncoder();
      const image = gpu.draw(encoder, program, { seconds: 0, beats: 0 }, () => input);
      encoder.copyTextureToBuffer({ texture: image }, { buffer, bytesPerRow: 256 }, [2, 1]);
      gpu.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      values.push(Array.from(new Uint16Array(buffer.getMappedRange(), 0, 4)));
      buffer.unmap();
      buffer.destroy();
      program.dispose();
    }
    input.destroy();
    gpu.device.destroy();
    return values;
  }, { module: origin + "/src/compositor/gpu.ts", plans });
  assert.deepEqual(samples, [
    [0x3400, 0, 0x3a00, 0x3c00], // 0.25 red over 0.75 blue, fully opaque.
    [0x3400, 0, 0, 0x3400], // Premultiplied red and alpha both reduced to 0.25.
    [0, 0, 0x3c00, 0x3c00], // Sample the blue texel after horizontal displacement.
    [0x3800, 0x3800, 0x3800, 0x3c00], // Convert the switch's Float back to grayscale Color.
  ]);
  assert.deepEqual(errors, []);
  if (process.env.COMPOSITOR_SCREENSHOT) await page.screenshot({ path: process.env.COMPOSITOR_SCREENSHOT });
  console.log("Compositor browser checks passed: video output, patch save and restore, WGSL diagnostics, phase-continuous Take, and GPU pixel tests.");
} finally {
  await browser.close();
}
