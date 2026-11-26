import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compile } from "../src/compositor/compiler";
import { connect, example, makeNode, projectFromJson, type Project } from "../src/compositor/graph";
import { DEFAULT_MEDIA_URL } from "../src/default-media";

const origin = process.env.COMPOSITOR_URL ?? "http://localhost:5173";
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: ["--enable-unsafe-webgpu", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const exampleVideo = origin + "/compositor-media/prism.mp4?example=ducks";
  await page.route(DEFAULT_MEDIA_URL, route => route.fulfill({
    json: [
      { name: "ducks", type: "video", url: exampleVideo, thumbnail: origin + "/test-assets/blue.png" },
      { name: "testcard", type: "image", url: origin + "/test-assets/blue.png" },
    ],
    headers: { "access-control-allow-origin": "*" },
  }));
  await page.addInitScript(`(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 80;
      canvas.height = 45;
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(25);
      Reflect.set(window, "testScreenCapture", stream);
      const interval = setInterval(() => {
        if (stream.getVideoTracks()[0].readyState === "ended") { clearInterval(interval); return; }
        context.fillStyle = "#f20";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 40);
      return stream;
    } });
  })()`);
  const forceCanvasUpload = process.env.COMPOSITOR_CANVAS_UPLOAD === "1";
  if (forceCanvasUpload) await page.addInitScript(() => {
    const counts = { video: 0, canvas: 0, sources: new Set<HTMLCanvasElement>() };
    Reflect.set(window, "videoUploadCounts", counts);
    const copy = GPUQueue.prototype.copyExternalImageToTexture;
    GPUQueue.prototype.copyExternalImageToTexture = function (source, destination, size) {
      if (source.source instanceof HTMLVideoElement) {
        counts.video++;
        throw new TypeError("This browser cannot use a video element as an external image source.");
      }
      if (source.source instanceof HTMLCanvasElement) {
        counts.canvas++;
        counts.sources.add(source.source);
      }
      return copy.call(this, source, destination, size);
    };
  });
  await page.goto(origin + "/compositor/");
  await page.getByRole("heading", { name: "PicoDevil Examples" }).waitFor();
  await page.getByRole("button", { name: "ducks Video", exact: true }).waitFor();
  await page.getByRole("button", { name: "testcard Image", exact: true }).waitFor();
  await page.waitForFunction(() => (window as any).compositor?.state().draftReady);
  assert.equal(await page.locator("#wires g").count(), 9);
  assert.match(await page.getByRole("button", { name: "Merge Factor input" }).getAttribute("title") ?? "", /luminance/);
  assert.equal(await page.locator('[data-node="merge"]').getByRole("combobox", { name: "Blend" }).inputValue(), "Normal");
  await page.locator('[data-node="steps"]').getByRole("button", { name: "Edit Steps…" }).click();
  const steps = page.getByRole("dialog", { name: "Step Sequencer" });
  await steps.getByRole("spinbutton", { name: "Step 1 value" }).fill("0.42");
  assert.equal(await page.locator('[data-node="steps"] .step-strip span').first().evaluate(node =>
    (node as HTMLElement).style.getPropertyValue("--level")), "0.42");
  await steps.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "View Output", exact: true }).click();
  const clocks = await page.evaluate(() => (window as any).compositor.state().time);
  assert.ok(clocks.seconds > 0);

  let [output] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open Output", exact: true }).click(),
  ]);
  await page.waitForFunction(() => (window as any).compositor.state().takes === 120);
  await output.locator("canvas").waitFor();
  await output.getByRole("status").waitFor({ state: "hidden" });
  assert.equal(await output.locator("canvas").evaluate((canvas: HTMLCanvasElement) => Boolean(canvas.getContext("2d"))), true);
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
  if (forceCanvasUpload) {
    await page.waitForFunction(() => Reflect.get(window, "videoUploadCounts").canvas >= 6);
    const counts = await page.evaluate(() => {
      const { video, canvas, sources } = Reflect.get(window, "videoUploadCounts");
      return { video, canvas, sources: sources.size };
    });
    assert.equal(counts.video, 1, "Detect unsupported video uploads once for the session.");
    assert.equal(counts.sources, 1, "Reuse a single canvas across the two playing videos.");
  }

  await page.getByRole("spinbutton", { name: "BPM" }).fill("136");
  await page.getByRole("spinbutton", { name: "BPM" }).press("Tab");
  await page.waitForFunction(() => {
    const state = (window as any).compositor.state();
    return state.draftReady && state.draftBpm === 136 && state.previewTime.beats - state.time.beats > 0.02;
  });
  const before = await page.evaluate(() => (window as any).compositor.state());
  assert.equal(before.takes, 120, "BPM edits must remain in Preview until Take.");
  await output.close();
  [output] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open Output", exact: true }).click(),
  ]);
  await output.getByRole("status").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => (window as any).compositor.state().takes), 120, "Reopening Output must keep the current live graph.");
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
  assert.ok(await page.getByRole("group", { name: "Node categories" }).getByRole("button", { name: /Shader/ }).isVisible());
  await page.getByRole("searchbox", { name: "Search nodes" }).fill("Custom Expresson");
  await page.getByRole("searchbox", { name: "Search nodes" }).press("Enter");
  await page.getByRole("button", { name: "Edit WGSL…" }).click();
  const expression = page.getByRole("dialog", { name: "Custom Expression" });
  await expression.getByRole("textbox", { name: "WGSL expression" }).fill("sin(a, b)");
  await page.locator('[data-node][data-error="true"]').waitFor();
  assert.notEqual(await expression.getByRole("alert").textContent(), "");
  await expression.getByRole("button", { name: "Done" }).click();

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
  const [filePicker] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Files", exact: true }).click()]);
  assert.equal(filePicker.isMultiple(), true);
  await filePicker.setFiles(fileURLToPath(new URL("../public/compositor-media/spectrum.mp4", import.meta.url)));
  const asset = page.getByRole("button", { name: "spectrum.mp4 Video", exact: true });
  await asset.waitFor();
  await asset.dragTo(page.locator("#graph"), { targetPosition: { x: 55, y: 60 } });
  await page.getByText("spectrum.mp4", { exact: true }).filter({ visible: true }).last().waitFor();
  assert.equal(await page.locator('[data-group="Media"].node').count(), 3);

  await page.getByRole("tab", { name: "Textures" }).click();
  await page.locator("#texture-assets .texture-tile").first().click();
  assert.equal(await page.locator('[data-kind="texture"].node').count(), 1);
  const textureNode = await page.locator('[data-kind="texture"].node').getAttribute("data-node");
  await page.locator('[data-kind="texture"].node').getByRole("button", { name: "Preview Texture" }).click();
  await page.locator('canvas[aria-label="Texture mini preview"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-kind="texture"].node')?.getAttribute("data-error") === "false");
  assert.ok(textureNode);
  await page.getByRole("tab", { name: "Audio" }).click();
  await page.getByRole("button", { name: "Enable microphone" }).click();
  await page.getByRole("button", { name: "Disable microphone" }).waitFor();
  await page.getByRole("button", { name: "Bass", exact: true }).click();
  await page.locator('[data-kind="audio"].node').getByRole("combobox", { name: "Band" }).waitFor();
  await page.getByRole("button", { name: "Disable microphone" }).click();
  await page.getByRole("button", { name: "Merge reference" }).click();
  assert.equal(await page.getByRole("tab", { name: "Reference" }).getAttribute("aria-selected"), "true");
  const referenceNav = page.getByRole("navigation", { name: "Reference nodes" });
  const referenceDetail = page.getByRole("region", { name: "Node documentation" });
  const [navigationBox, detailBox] = await Promise.all([referenceNav.boundingBox(), referenceDetail.boundingBox()]);
  assert.ok(navigationBox && detailBox && detailBox.x >= navigationBox.x + navigationBox.width);
  assert.equal(await referenceNav.getByRole("link", { name: "Merge", exact: true }).getAttribute("aria-current"), "location");
  assert.ok(await referenceDetail.evaluate(element => element.scrollTop > 0));
  await referenceNav.getByRole("button", { name: "Toggle Composite" }).click();
  assert.equal(await referenceNav.getByRole("link", { name: "Merge", exact: true }).count(), 0);
  assert.ok(await referenceDetail.getByRole("heading", { name: "Merge", exact: true }).isVisible());
  const referenceSearch = page.getByRole("searchbox", { name: "Search reference" });
  await referenceSearch.fill("Step Sequencer");
  await referenceNav.getByRole("link", { name: "Step Sequencer", exact: true }).click();
  assert.equal(await referenceDetail.getByRole("heading", { name: "Merge", exact: true }).count(), 0);
  await referenceDetail.getByRole("link", { name: "LFO", exact: true }).click();
  await referenceNav.getByRole("link", { name: "LFO", exact: true }).waitFor();
  assert.equal(await referenceNav.getByRole("link", { name: "LFO", exact: true }).getAttribute("aria-current"), "location");

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
  await page.getByRole("button", { name: "Apply Mask Mask input" }).click({ modifiers: ["Alt"] });
  assert.equal(await page.locator("#wires g").count(), 9);
  const tail = page.locator("#wires .wire-hit").last();
  const midpoint = await tail.evaluate((hit: SVGPathElement) => {
    const point = hit.getPointAtLength(hit.getTotalLength() / 2).matrixTransform(hit.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(midpoint.x, midpoint.y, { button: "right" });
  await page.getByRole("searchbox", { name: "Search nodes" }).fill("Displace");
  await page.getByRole("searchbox", { name: "Search nodes" }).press("Enter");
  assert.equal(await page.locator('[data-kind="displace"].node').count(), 2);
  assert.equal(await page.locator("#wires g").count(), 10);
  const newMidpoint = await page.locator("#wires .wire-hit").first().evaluate((hit: SVGPathElement) => {
    const point = hit.getPointAtLength(hit.getTotalLength() / 2).matrixTransform(hit.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.dblclick(newMidpoint.x, newMidpoint.y);
  assert.equal(await page.locator('[data-kind="junction"].node').count(), 1);
  assert.equal(await page.locator("#wires g").count(), 11);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator("#wires g").count(), 10);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(await page.locator('[data-kind="junction"].node').count(), 1);

  await page.evaluate(graph => (window as any).compositor.load(graph), base);
  const viewport = await page.locator("#graph").boundingBox();
  const sourcePort = await page.getByRole("button", { name: "Noise Float output" }).boundingBox();
  assert.ok(viewport && sourcePort);
  await page.mouse.move(sourcePort.x + sourcePort.width / 2, sourcePort.y + sourcePort.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width - 35, viewport.y + viewport.height - 40, { steps: 8 });
  await page.mouse.up();
  const search = page.getByRole("searchbox", { name: "Search nodes" });
  await search.fill("Video");
  await page.getByText("No matching nodes", { exact: true }).waitFor();
  await search.fill("Math Multiply");
  await search.press("Enter");
  assert.equal(await page.locator('[data-kind="math"].node').getByRole("combobox", { name: "Operation" }).inputValue(), "Multiply");
  assert.equal(await page.locator("#wires g").count(), 10);

  await page.evaluate(graph => (window as any).compositor.load(graph), {
    ...base, nodes: [...base.nodes, makeNode("mask", 800, 450, "move-test")],
  });
  const move = await page.locator('[data-node="move-test"] .node-title').boundingBox();
  const cable = await page.locator("#wires .wire-hit").last().evaluate((hit: SVGPathElement) => {
    const point = hit.getPointAtLength(hit.getTotalLength() / 2).matrixTransform(hit.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  assert.ok(move);
  await page.mouse.move(move.x + 14, move.y + 6);
  await page.mouse.down();
  await page.mouse.move(cable.x, cable.y, { steps: 8 });
  await page.locator("#wires .wire-inserting").waitFor({ state: "attached" });
  await page.mouse.up();
  assert.equal(await page.locator("#wires g").count(), 10);

  const source = makeNode("color", 0, 0, "fg", { color: "#ff0000", alpha: 0.5 });
  const blue = makeNode("color", 0, 0, "bg", { color: "#0000ff" });
  const legacy = projectFromJson({
    version: 1, bpm: 120, edges: [], nodes: [
      { ...source, params: { color: "#ff0000", alpha: 0.5 } },
      { ...makeNode("ramp", 0, 0, "ramp"), params: { low: "#000000", high: "#ffffff", from: 0, to: 1 } },
      { ...makeNode("value", 0, 0, "number"), params: { value: 0.5 } },
    ],
  });
  assert.deepEqual(legacy.nodes[0].params, { "input:color": { hex: "#ff0000", alpha: 0.5 } });
  assert.deepEqual(legacy.nodes[1].params["input:high"], { hex: "#ffffff", alpha: 1 });
  assert.equal(legacy.nodes[2].params.type, "Float");
  assert.deepEqual(projectFromJson(JSON.parse(JSON.stringify(legacy))), legacy);
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
    testPlan([source, makeNode("ramp", 0, 0, "typed-ramp"), makeNode("value", 0, 0, "integer", { type: "Integer", value: 1 })], [
      { from: "fg", to: "typed-ramp", input: "high" },
      { from: "integer", to: "typed-ramp", input: "factor" },
    ], "typed-ramp"),
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
    [0x3800, 0, 0, 0x3800], // Integer Factor selects the connected, translucent red stop.
  ]);

  await page.getByRole("tab", { name: "Videos" }).click();
  const urlInput = page.getByRole("textbox", { name: "Paste URL to add" });
  const linkedVideo = origin + "/test-assets/red.mp4?linked=1";
  await urlInput.fill(linkedVideo);
  await urlInput.press("Enter");
  await page.getByRole("button", { name: "red Video", exact: true }).waitFor();
  await urlInput.fill(linkedVideo);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("red is already in Videos.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "red Video", exact: true }).count(), 1);

  const videoServer = origin + "/test-video-server";
  await page.evaluate(server => localStorage.setItem("picodevil-server-url", server), videoServer);
  await page.route(`${videoServer}/download?*`, route => route.fulfill({
    json: { url: origin + "/compositor-media/spectrum.mp4?youtube=1", ready: true },
  }));
  await urlInput.fill("https://www.youtube.com/watch?v=demo_test");
  await urlInput.press("Enter");
  await page.getByRole("button", { name: "demo_test Video", exact: true }).waitFor();

  const loadVideo = async (asset: string, bpm: number) => {
    await page.evaluate(graph => (window as any).compositor.load(graph), {
      ...base, bpm, nodes: base.nodes.map(node => node.id === "a" ? { ...node, params: { ...node.params, asset } } : node),
    });
    await page.waitForFunction(bpm => {
      const state = (window as any).compositor.state();
      return state.draftReady && state.draftBpm === bpm;
    }, bpm);
  };
  const takeVideo = async (bpm: number) => {
    await page.getByRole("button", { name: "Take", exact: true }).click();
    await page.waitForFunction(bpm => (window as any).compositor.state().takes === bpm, bpm);
  };
  await loadVideo(`url:${exampleVideo}`, 140);
  await takeVideo(140);
  await loadVideo(`url:${linkedVideo}`, 141);
  await takeVideo(141);
  await loadVideo("capture:webcam", 142);
  await page.getByRole("button", { name: "Take", exact: true }).click();
  await page.getByText("Start Webcam in Videos before Take.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).compositor.state().takes), 141);
  await page.getByRole("button", { name: "Webcam", exact: true }).click();
  await page.getByRole("button", { name: "Webcam Live", exact: true }).waitFor();
  await takeVideo(142);
  await page.getByRole("button", { name: "Stop Webcam", exact: true }).click();
  await page.getByRole("button", { name: "Webcam Stopped", exact: true }).waitFor();
  await page.getByRole("button", { name: "Screen", exact: true }).click();
  await page.getByRole("button", { name: "Screen Live", exact: true }).waitFor();
  await loadVideo("capture:screen", 143);
  await takeVideo(143);
  await page.getByRole("button", { name: "Stop Screen", exact: true }).click();
  assert.equal(await page.evaluate(() => Reflect.get(window, "testScreenCapture").getVideoTracks()[0].readyState), "ended");
  await output.close();
  await loadVideo(`url:${exampleVideo}`, 144);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Project saved in this browser.", { exact: true }).waitFor();
  await page.route(DEFAULT_MEDIA_URL, route => route.abort());
  await page.reload();
  await page.getByText("PicoDevil examples are unavailable.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "red Video", exact: true }).waitFor();
  await page.waitForFunction(() => (window as any).compositor?.state().draftReady);
  await page.evaluate(graph => (window as any).compositor.load(graph), {
    ...base, nodes: base.nodes.filter(node => node.kind !== "output"), edges: base.edges.filter(edge => edge.to !== "out"),
  });
  await page.waitForFunction(() => Boolean((window as any).compositor.state().error));
  const [invalidOutput] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open Output", exact: true }).click(),
  ]);
  await invalidOutput.getByText("Add exactly one Output node.", { exact: true }).waitFor();
  await invalidOutput.close();
  await page.getByRole("button", { name: "Open saved", exact: true }).click();
  await page.waitForFunction(() => (window as any).compositor?.state().draftReady && (window as any).compositor.state().draftBpm === 144);
  await takeVideo(144);

  const typedControls = connect(connect({
    ...base, nodes: [...base.nodes,
      makeNode("value", 265, 35, "numeric-control", { value: -2.5 }),
      makeNode("junction", 512, 50, "typed-reroute"),
      makeNode("color", 265, 165, "rgba-control"),
    ],
  }, { from: "numeric-control", to: "typed-reroute", input: "in" }), { from: "typed-reroute", to: "merge", input: "factor" });
  await page.evaluate(graph => (window as any).compositor.load(graph), typedControls);
  const numeric = page.locator('[data-node="numeric-control"]');
  await numeric.getByRole("combobox", { name: "Type" }).selectOption("Integer");
  assert.equal(await numeric.getByRole("spinbutton", { name: "Value" }).inputValue(), "-3");
  assert.match(await page.getByRole("button", { name: "Merge Factor input" }).getAttribute("title") ?? "", /Integer → Float/);
  assert.equal(await page.locator('[data-node="typed-reroute"] .port.out').getAttribute("data-type"), "integer");
  const alpha = page.locator('[data-node="rgba-control"]').getByRole("spinbutton", { name: "Color Alpha" });
  await alpha.fill("0.25");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Project saved in this browser.", { exact: true }).waitFor();
  await alpha.fill("0.75");
  await page.getByRole("button", { name: "Open saved", exact: true }).click();
  await page.getByText("Saved project opened in Preview.", { exact: true }).waitFor();
  assert.equal(await alpha.inputValue(), "0.25");

  assert.deepEqual(errors, []);
  if (process.env.COMPOSITOR_SCREENSHOT) await page.screenshot({ path: process.env.COMPOSITOR_SCREENSHOT });
  console.log("Compositor browser checks passed: video output, patch save and restore, WGSL diagnostics, phase-continuous Take, and GPU pixel tests.");
} finally {
  await browser.close();
}
