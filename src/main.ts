import "./visual-controls";
import { setupEditor } from "./editor";
import "./shuffle-stack";
import { CYCLES_PER_SECOND, setRuntimeCps, MAX_FREE_VIDEO_ELEMENTS } from "./config";
import { CpsController } from "./cps-controller";
import { createMetrics, recordFrameMetrics } from "./frame-metrics";
import { resolveMedia, addMedia, clearAll as clearMediaRegistry, setDurationByUrl, loadVideo, loadImage, getAllEntries, initRegistry, addOnChange } from "./media-registry";
import { resolveUrl, probeHealth, shouldAutoProbeOnStartup } from "./server-config";
import { initRegistry as initPatternRegistry, each, all } from "./pattern-registry";
import { loadFromUrl, saveToUrl, setUrlWarnCallback, hashLooksCorrupt } from "./url-state";
import { blockStarter, setupBlockEditor } from "./block-editor";
import { createVideoPoolManager } from "./video-pool-manager";
import { slider as sliderWidget, fontPicker as fontPickerWidget } from "./widgets";
import { initFontList } from "./font-list";
import { repopulateFontDatalist } from "./editor-widgets";
import { warn, flushWarnings } from "./warnings";
import { warnOnMediaLoadError } from "./media-errors";
import { setupSidebar } from "./sidebar";
import { loadCamera, loadScreen } from "./stream-manager";
import { fft, updateFrame as fftUpdateFrame, applyFftConfig, getFftConfig, onFftConfigChange } from "./fft-audio";
import { WebGLRenderer } from "./webgl-renderer";
import { showFatalOverlay, rendererFailureMessage } from "./fatal-overlay";
import { FrameRenderer } from "./renderer";
import type { Renderer } from "./renderer-interface";
import { EvalController } from "./eval-controller";
import { Projection } from "./projection";

import { Pattern, useRNG } from "@strudel/core";
useRNG('precise');
initPatternRegistry();

const canvas = document.getElementById("c") as HTMLCanvasElement;

// The entire app is a WebGL2 canvas. If the context can't be created (no WebGL2,
// hardware acceleration disabled, blocklisted GPU), the WebGLRenderer constructor
// throws — catch it and show an explainer instead of a silent black page + dead
// editor (the throw would otherwise abort the whole module).
let activeRenderer: Renderer;
try {
  activeRenderer = new WebGLRenderer(canvas, {
    // Repeated unrecoverable context loss (e.g. a Windows GPU stuck resetting) —
    // stop flashing black and tell the user what to try.
    onUnrecoverable: () => showFatalOverlay(
      "picodevil lost the graphics context",
      "The GPU repeatedly dropped picodevil's graphics context and it couldn't recover. " +
      "This is usually an out-of-date graphics driver or the GPU running out of memory — " +
      "try updating your drivers, a simpler pattern, or a smaller window, then reload.",
    ),
  });
} catch (err) {
  // The throw sites (webgl-renderer.ts) already console.error the specifics; log
  // once more here with the error object (stack) so there's always a top-level
  // marker even if the overlay fails to render.
  console.error("[picodevil] renderer initialisation failed:", err);
  const { title, message } = rendererFailureMessage(err);
  showFatalOverlay(title, message);
  throw err;
}

const projection = new Projection(() => { resize(); scheduleFrame(); });

function resize() {
  const output = projection.outputWindow;
  const bounds = canvas.getBoundingClientRect();
  const density = output?.devicePixelRatio ?? devicePixelRatio;
  const width = Math.max(1, Math.round((output?.innerWidth ?? bounds.width) * density));
  const height = Math.max(1, Math.round((output?.innerHeight ?? bounds.height) * density));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  activeRenderer.resize(width, height);
}
window.addEventListener("resize", resize);
resize();

// --- performance metrics (exposed for stress testing) ---
const pdMetrics = createMetrics();
(window as any).pdMetrics = pdMetrics;
(window as any).pdPerfInfo = () => {
  const autoFBO = activeRenderer.getAutoFBOStats?.() ?? { count: 0, bytes: 0, pooled: 0 };
  return {
    naturalCount: pdMetrics.naturalCount,
    seekCount: pdMetrics.seekModeCount,
    screensCount: pdMetrics.screensCount,
    eventsPerFrame: pdMetrics.eventsPerFrame,
    seeksThisFrame: pdMetrics.seeksThisFrame,
    seeksPer300f: pdMetrics.seeksHistory.reduce((a, b) => a + b, 0),
    driftSeeksPer300f: pdMetrics.driftSeeksHistory.reduce((a, b) => a + b, 0),
    autoFBOCount: autoFBO.count,
    autoFBOBytes: autoFBO.bytes,
    // Cumulative zero-footprint-skip guard violations (internal footprint bugs).
    // frameRenderer is defined below; pdPerfInfo only runs after module init.
    modSkipViolations: frameRenderer.modSkipViolations,
  };
};

// --- video pool ---
const pool = createVideoPoolManager({
  resolveMediaUrl: (name, base) => {
    const entry = resolveMedia(name);
    return entry ? resolveUrl(entry.url) : base + name;
  },
  onDurationDiscovered: (srcUrl, duration) => {
    setDurationByUrl(srcUrl, duration);
  },
  createElement: () => {
    const el = document.createElement("video");
    el.crossOrigin = "anonymous";
    warnOnMediaLoadError(el); // surface a 404/decode failure instead of a silent black tile
    return el;
  },
  maxFreeTotal: MAX_FREE_VIDEO_ELEMENTS,
  // Free the GPU texture when the pool permanently evicts an element, so video
  // textures + detached elements don't accumulate over a long set.
  onDestroyElement: (el) => activeRenderer.releaseSource?.(el),
});

const frameRenderer = new FrameRenderer(activeRenderer, pool, pdMetrics);
const cpsController = new CpsController(CYCLES_PER_SECOND, performance.now());

/**
 * Sets the global cycles per second (tempo). Default is 0.5 (one cycle = 2 seconds).
 *
 * @param {number} cps cycles per second
 * @example
 * setCps(1)   // one cycle per second
 * setCps(0.25) // one cycle every 4 seconds
 *
 */
function setCps(cps: number | Pattern) {
  cpsController.setCps(cps, performance.now());
}

function setCpm(cpm: number | Pattern) {
  cpsController.setCpm(cpm, performance.now());
}

// Expose media registry for monkey tester
(window as any).pdAddMedia = addMedia;
(window as any).pdClearMedia = clearMediaRegistry;

const evalController = new EvalController({
  clearActiveVideos: () => pool.clearVideos(frameRenderer.activeVideoEls.splice(0)),
  snapshotCps: () => cpsController.snapshot(),
  restoreCps: (snap) => cpsController.restore(snap),
  globals: {
    setCps, setCpm,
    loadVideo, loadImage, loadCamera, loadScreen,
    slider: sliderWidget,
    fontPicker: fontPickerWidget,
    each, all,
    fft,
  },
});

initFontList(repopulateFontDatalist);

// Probe the optional companion server in the background so server-gated flows
// (upload/download) know whether it's reachable. We deliberately DON'T probe a
// localhost server from the public site on first load — that fetch springs the
// browser's "access devices on your local network" permission prompt before the
// user has asked for anything. We only auto-probe when it wouldn't prompt (a
// remote server, or a localhost dev server) or once we've connected before (the
// prompt is already behind us). Otherwise the probe is deferred until the user
// opens the server box and closes it on a localhost URL (see server-settings-ui).
if (shouldAutoProbeOnStartup()) {
  probeHealth().catch(() => {/* status set internally */});
}

// called from editor on ctrl+enter
window.pdEval = (code) => evalController.eval(code);

// Reset tempo to the default cps. Called when loading an example so a previous
// example's setCps()/setCpm() doesn't carry over into one that doesn't set it.
(window as any).pdResetCps = () => cpsController.reset(performance.now());

// --- render loop ---
let lastRafAbsTime = performance.now();
let rafPaused = false;
let scheduled: { host: Window; id: number } | undefined;

function scheduleFrame() {
  const output = projection.outputWindow;
  const host = output && !output.document.hidden ? output : window;
  if (scheduled?.host === host) return;
  if (scheduled) scheduled.host.cancelAnimationFrame(scheduled.id);
  scheduled = { host, id: host.requestAnimationFrame(() => {
    scheduled = undefined;
    frame();
  }) };
}

// Expose active video elements for testing/debugging
(window as any)._pdActiveVideoEls = frameRenderer.activeVideoEls;

function frame() {
  scheduleFrame();
  if (rafPaused) return;
  // Skip rendering while the GPU context is lost — issuing GL calls into a dead
  // context spews errors and can starve the browser's chance to restore it.
  if (activeRenderer.isContextLost?.()) return;
  const rafAbsNow = performance.now();
  const interFrameGap = rafAbsNow - lastRafAbsTime;
  lastRafAbsTime = rafAbsNow;

  const { cps, cycle, t } = cpsController.tick(rafAbsNow);
  setRuntimeCps(cps);
  fftUpdateFrame();

  frameRenderer.render(evalController.screens, evalController.namedScreens, t, cps, cycle, rafAbsNow);
  projection.present(canvas);

  // Test hook: expose the live loop's current frame coordinates so a capture
  // harness can phase-sample the running render (re-render the exact live cycle
  // for readback) instead of driving its own competing cycle.
  (window as any).pdLiveFrame = { cycle, cps, wall: rafAbsNow };

  const frameDuration = performance.now() - rafAbsNow;
  const perfMem = (performance as any).memory;
  recordFrameMetrics(
    pdMetrics, frameDuration, interFrameGap,
    frameRenderer.activeVideoEls, pool.freeVideoPool,
    evalController.screens.length, frameRenderer.lastEventCount,
    perfMem ? perfMem.usedJSHeapSize : undefined,
  );

  flushWarnings();
}
scheduleFrame();

// Test-only deterministic-render hooks. Used by golden-render harness and
// future visual regression tests. pdRenderAt synchronously renders one frame
// at a caller-supplied cycle position; pdPauseRaf stops the running rAF loop
// so subsequent captures aren't overwritten before being read.
(window as any).pdPauseRaf = () => { rafPaused = true; };
(window as any).pdResumeRaf = () => { rafPaused = false; };
// `wallMs`, when supplied, pins the wall-clock time handed to the renderer
// instead of `performance.now()`. Wall-clock-driven playback (sync()/rolling())
// otherwise advances between two renders at the same cycle, so a settle loop
// never stabilizes; pinning it lets warm video renders be reproducible.
(window as any).pdRenderAt = (cycle: number, cps = 0.5, wallMs?: number) => {
  const t = Math.floor(cycle) + (cycle % 1);
  setRuntimeCps(cps);
  const wall = wallMs ?? performance.now();
  frameRenderer.render(evalController.screens, evalController.namedScreens, t, cps, cycle, wall);
  projection.present(canvas);
};

// --- URL state ---
let currentCode = blockStarter;
export function getCurrentCode(): string { return currentCode; }

const urlState = loadFromUrl();
if (!urlState && hashLooksCorrupt(window.location.hash)) {
  // The link carried a v1 state envelope that didn't decode (truncated by a chat
  // app/proxy, hand-edited, etc.). Tell the user their work was dropped instead of
  // silently opening a fresh session.
  warn("This shared link looks corrupted or truncated — couldn't restore it, starting a fresh session instead.");
}
if (urlState) {
  initRegistry(urlState.media);
  currentCode = urlState.code;
  if (urlState.fft) applyFftConfig(urlState.fft);
}

setUrlWarnCallback((msg) => { if (msg) warn(msg); });
const saveUrl = () => saveToUrl(currentCode, getAllEntries(), getFftConfig());
addOnChange(saveUrl);
onFftConfigChange(saveUrl);

// --- editor ---
const editor = setupEditor(
  document.getElementById("editor-wrap")!,
  currentCode,
  (code) => {
    currentCode = code;
    saveUrl();
  },
);

const blockHost = document.getElementById("bd-editor")!;
const codeHost = document.getElementById("editor-wrap")!;
const codeStatus = document.getElementById("bd-code-status")!;
const blocksButton = document.getElementById("bd-show-blocks")!;
const codeButton = document.getElementById("bd-show-code")!;
const setCode = window.pdSetCode;
let mode: "blocks" | "code" = "code";
let blockSource: string | undefined;

const blockEditor = setupBlockEditor(blockHost, {
  run(code) {
    const error = setCode(code, true) ?? null;
    if (!error) blockSource = code;
    return error;
  },
  openExample(code) {
    const error = blockEditor.load(code);
    if (error) { blockEditor.setStatus(error, true); return; }
    cpsController.reset(performance.now());
    blockEditor.run();
  },
});

function showMode(next: typeof mode, message = "") {
  mode = next;
  const blocks = next === "blocks";
  codeHost.hidden = blocks;
  blockHost.hidden = !blocks;
  document.body.classList.toggle("bd-blocks", blocks);
  blocksButton.setAttribute("aria-pressed", String(blocks));
  codeButton.setAttribute("aria-pressed", String(!blocks));
  codeStatus.textContent = message;
  codeStatus.hidden = !message;
  if (blocks) blockEditor.layout();
  resize();
}

function showBlocks(code: string) {
  if (code !== blockSource) {
    const error = blockEditor.load(code);
    if (error) {
      showMode("code", `Opened in Code. ${error}`);
      return;
    }
    blockSource = code;
  }
  showMode("blocks");
}

blocksButton.addEventListener("click", () => showBlocks(editor.state.doc.toString()));
codeButton.addEventListener("click", () => {
  if (mode === "code") return;
  try {
    const code = blockEditor.getCode();
    setCode(code, false);
    blockSource = code;
    showMode("code");
  } catch {
    showMode("code", "Showing the last complete patch. The unfinished blocks are still in Blocks.");
  }
  editor.focus();
});

window.pdSetCode = (code, evaluate) => {
  const error = setCode(code, evaluate);
  if (mode === "blocks") showBlocks(editor.state.doc.toString());
  return error;
};

projection.bindToggle(document.querySelector<HTMLButtonElement>("#bd-projection-toggle")!);
document.getElementById("bd-open-output")!.addEventListener("click", () => projection.open());
showBlocks(currentCode);
// A fresh session = no saved URL state. Tells the media loader to auto-pull the
// curated CDN defaults so a first-time visitor lands with media ready.
setupSidebar(!urlState, !document.body.classList.contains("bd-blocks"));
