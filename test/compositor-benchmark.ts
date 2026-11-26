import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { compile } from "../src/compositor/compiler";
import { example } from "../src/compositor/graph";

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, "").split("=")));
const origin = args.url ?? "http://localhost:5173";
const seconds = Number(args.seconds ?? 30);
const runs = Number(args.runs ?? 3);
const only = args.only;
assert.ok(seconds > 0 && Number.isInteger(runs) && runs > 0);
const fixture = compile(example());

function stats(list: number[]) {
  if (!list.length) return null;
  const values = [...list].sort((a, b) => a - b);
  return { n: values.length, p50: values[Math.floor(values.length * 0.5)], p95: values[Math.floor(values.length * 0.95)] };
}

function missed(intervals: number[], frames: number) {
  const missed = intervals.reduce((count, ms) => count + Math.max(0, Math.round(ms / (1000 / 60)) - 1), 0);
  return { count: missed, percent: 100 * missed / (missed + frames) };
}

async function projection(page: import("playwright").Page) {
  const [output] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open Output", exact: true }).first().click(),
  ]);
  const cdp = await page.context().newCDPSession(output);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await output.locator("canvas").waitFor();
  return output;
}

async function legacy(browser: Browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript("globalThis.__name = fn => fn");
  await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const graph = { nodes: [
    { id: "a", kind: "media", x: 40, y: 40, data: { media: "test-a" } },
    { id: "b", kind: "media", x: 40, y: 200, data: { media: "test-b" } },
    { id: "d", kind: "modulate", x: 295, y: 30, data: { value: 0.1 } },
    { id: "m", kind: "matte", x: 535, y: 30, data: { value: 1 } },
    { id: "mix", kind: "blend", x: 775, y: 30, data: { mode: "source-over" } },
    { id: "out", kind: "output", x: 1015, y: 30, data: {} },
  ], edges: [
    { from: "a", to: "d", input: "image" }, { from: "b", to: "d", input: "texture" },
    { from: "d", to: "m", input: "image" }, { from: "b", to: "m", input: "texture" },
    { from: "b", to: "mix", input: "image" }, { from: "m", to: "mix", input: "second" },
    { from: "mix", to: "out", input: "image" },
  ], variables: [] };
  await page.addInitScript(session => localStorage.setItem("nodesdevil-session-v1", JSON.stringify(session)), {
    draft: graph, live: graph, view: { x: 0, y: 0, zoom: 0.85, previews: ["d"] },
    media: [{ id: "test-a", name: "prism", url: origin + "/compositor-media/prism.mp4", type: "video" },
      { id: "test-b", name: "spectrum", url: origin + "/compositor-media/spectrum.mp4", type: "video" }],
  });
  await page.goto(origin);
  await page.waitForFunction(() => (window as any).pdMetrics?.eventsPerFrame > 0);
  const output = await projection(page);
  await page.waitForFunction(() => (document.getElementById("c") as HTMLCanvasElement).width === 1920 &&
    (document.getElementById("c") as HTMLCanvasElement).height === 1080);
  await page.locator(".nd-preview canvas:visible").first().waitFor();
  await page.waitForTimeout(3500);
  const result = [];
  for (let run = 0; run < runs; run++) {
    const data = await page.evaluate(async duration => {
      const work: number[] = [], query: number[] = [], draw: number[] = [];
      const observer = new PerformanceObserver(list => {
        for (const event of list.getEntries()) {
          if (event.name === "pd query") query.push(event.duration);
          if (event.name === "pd draw") draw.push(event.duration);
        }
      });
      observer.observe({ entryTypes: ["measure"] });
      const intervals: number[] = [];
      const start = performance.now();
      const state = window as any;
      let last = state.pdLiveFrame?.wall ?? 0;
      await new Promise<void>(resolve => {
        const frame = () => {
          const next = state.pdLiveFrame?.wall ?? 0;
          if (next > last) {
            if (last) intervals.push(next - last);
            last = next;
            const latest = state.pdMetrics.frameTimes.at(-1);
            if (latest !== undefined) work.push(latest);
          }
          if (performance.now() - start >= duration) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      observer.disconnect();
      const metrics = (window as any).pdMetrics;
      return { work, query, draw, intervals, eventsPerFrame: metrics.eventsPerFrame };
    }, seconds * 1000);
    result.push({ workMs: stats(data.work), queryMs: stats(data.query), drawMs: stats(data.draw), intervalsMs: stats(data.intervals),
      missed: missed(data.intervals, data.intervals.length + 1), eventsPerFrame: data.eventsPerFrame });
  }
  const previewVisible = await page.locator(".nd-preview canvas:visible").count();
  await output.close();
  await page.close();
  return { previewVisible, runs: result };
}

async function newEditor(browser: Browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(origin + "/compositor/");
  await page.getByRole("button", { name: "Take", exact: true }).click();
  const output = await projection(page);
  await page.waitForFunction(() => (window as any).compositor.state().takes === 120);
  await page.locator('[data-node="noise"] .node-head').click();
  const adapter = await page.evaluate(() => (window as any).compositor.adapter());
  assert.ok(!adapter.fallback, "The Chrome adapter is software-only.");
  const tracks = [];
  for (const preview of [false, true]) {
    await page.evaluate(enabled => (window as any).compositor.setPreview(enabled), preview);
    await page.waitForTimeout(3500);
    const result = [];
    for (let run = 0; run < runs; run++) {
      await page.evaluate(() => (window as any).compositor.begin());
      await page.waitForTimeout(seconds * 1000);
      const sample = await page.evaluate(() => (window as any).compositor.end());
      assert.ok(sample.outputFrames > 0 && sample.decode.length > 0, "No program output or decoded frames recorded.");
      if (preview) assert.ok(sample.preview.length > 0, "Draft preview did not render during measurement.");
      result.push({ outputFrames: sample.outputFrames, queueSkips: sample.skipped, missed: missed(sample.intervals, sample.outputFrames),
        workMs: stats(sample.work), completionMs: stats(sample.completion), intervalsMs: stats(sample.intervals), decodeMs: stats(sample.decode),
        uploadMs: stats(sample.uploads), programMs: stats(sample.program), previewMs: stats(sample.preview) });
    }
    tracks.push({ preview, runs: result });
  }
  await output.close();
  await page.close();
  return { adapter, tracks };
}

async function browserGpu(browser: Browser) {
  const page = await browser.newPage();
  await page.addInitScript("globalThis.__name = fn => fn");
  const url = origin + "/compositor-benchmark-harness";
  await page.route(url, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>GPU benchmark</title>" }));
  await page.goto(url);
  const result = await page.evaluate(async ({ plan, module, seconds, runs }) => {
    const { Renderer } = await import(module);
    const renderer = await Renderer.create();
    const { device, adapter } = renderer;
    const route = await renderer.prepare(plan, 1920, 1080);
    const textures = new Map([["demo-a", renderer.fixture(1920, 1080, 1)], ["demo-b", renderer.fixture(1920, 1080, 2)]]);
    const query = device.features.has("timestamp-query") ? device.createQuerySet({ type: "timestamp", count: 2 }) : undefined;
    const resolve = query && device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = query && device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const draw = async (seconds: number) => {
      const start = performance.now();
      const encoder = device.createCommandEncoder();
      renderer.draw(encoder, route, { seconds, beats: seconds * 2 }, (asset: string) => textures.get(asset), query);
      if (query && resolve && read) {
        encoder.resolveQuerySet(query, 0, 2, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
      }
      device.queue.submit([encoder.finish()]);
      let gpu: number | undefined;
      if (read) {
        await read.mapAsync(GPUMapMode.READ);
        const value = new BigUint64Array(read.getMappedRange());
        gpu = Number(value[1] - value[0]) / 1e6;
        read.unmap();
      } else await device.queue.onSubmittedWorkDone();
      return { wall: performance.now() - start, gpu };
    };
    const warm = performance.now();
    while (performance.now() - warm < 2000) await draw((performance.now() - warm) / 1000);
    const samples = [];
    for (let run = 0; run < runs; run++) {
      const wall: number[] = [], gpu: number[] = [];
      const start = performance.now();
      for (let index = 0; index < seconds * 60; index++) {
        const delay = start + index * 1000 / 60 - performance.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        const result = await draw(index / 60);
        wall.push(result.wall);
        if (result.gpu !== undefined) gpu.push(result.gpu);
      }
      samples.push({ wall, gpu });
    }
    return { adapter: { vendor: adapter.info.vendor, fallback: adapter.info.isFallbackAdapter },
      samples, passes: route.passes.length };
  }, { plan: fixture, module: origin + "/src/compositor/gpu.ts", seconds, runs });
  await page.close();
  return { adapter: result.adapter, passes: result.passes,
    runs: result.samples.map(sample => ({ submitAndWaitMs: stats(sample.wall), gpuMs: stats(sample.gpu) })) };
}

if (args.fixture) await writeFile(args.fixture, JSON.stringify(fixture), "utf8");
if (only !== "fixture") {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu"] });
  try {
    if (!only || only === "legacy") console.log(JSON.stringify({ legacy: await legacy(browser) }, null, 2));
    if (!only || only === "compositor") console.log(JSON.stringify({ compositor: await newEditor(browser) }, null, 2));
    if (!only || only === "gpu") console.log(JSON.stringify({ browserGpu: await browserGpu(browser) }, null, 2));
  } finally { await browser.close(); }
}
