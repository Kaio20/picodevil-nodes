import "./visual-controls";
import { setupEditor } from "./editor";
import "./shuffle-stack";
import { CYCLES_PER_SECOND, setRuntimeCps, MAX_FREE_VIDEO_ELEMENTS } from "./config";
import { CpsController } from "./cps-controller";
import { createMetrics, recordFrameMetrics } from "./frame-metrics";
import { resolveMedia, resolveMediaId, addMedia, clearAll as clearMediaRegistry, setDurationByUrl, loadVideo, loadImage, getAllEntries, importAll, initRegistry, addOnChange } from "./media-registry";
import { probeHealth, shouldAutoProbeOnStartup } from "./server-config";
import { initRegistry as initPatternRegistry, restoreRegistry, each, all } from "./pattern-registry";
import { loadFromUrl, saveToUrl, cancelUrlSave, setUrlWarnCallback, hashLooksCorrupt, persistableMedia, type UrlMediaEntry } from "./url-state";
import { defaultCode } from "./editor";
import { pickAutostartCode } from "./examples";
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
import { starterGraph, type Graph } from "./node-graph";
import { NodeEditor } from "./node-editor";
import { compileLiveGraph, mediaUrl, NodePreviews, readLiveGraph, registerLiveGraph } from "./node-runtime";
import { NodeMotions, NodeTransport } from "./node-transport";
import { exportNodeCode } from "./node-code";
import { NodeProjection } from "./node-projection";
import { loadNodes, saveNodes, type NodeSession } from "./node-session";
import { createExampleGraph } from "./node-examples";
import { loadExampleMedia } from "./media-loader";
import { loadTextureLibrary, onTextureLibraryChange } from "./texture-library";

import { Pattern, useRNG } from "@strudel/core";
useRNG('precise');
initPatternRegistry();
const textureLibraryReady = loadTextureLibrary();

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
      "NodesDevil lost the graphics context",
      "The GPU repeatedly dropped NodesDevil's graphics context and it couldn't recover. " +
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

const projection = new NodeProjection(() => { resize(); scheduleFrame(); });
const previews = new NodePreviews();

function resize() {
  const output = projection.outputWindow ?? window;
  const width = Math.max(1, Math.round(output.innerWidth * output.devicePixelRatio));
  const height = Math.max(1, Math.round(output.innerHeight * output.devicePixelRatio));
  document.body.classList.toggle("nd-output-open", output !== window);
  if (canvas.width === width && canvas.height === height && canvas.dataset.sized) return;
  canvas.dataset.sized = "true";
  canvas.width = width;
  canvas.height = height;
  activeRenderer.resize(canvas.width, canvas.height);
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
  resolveMediaUrl: mediaUrl,
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
const nodeTransport = new NodeTransport();
let liveMotions = new NodeMotions();

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

function importNodeMedia(media: UrlMediaEntry[]) {
  const missing = media.filter(entry => !resolveMediaId(entry.id));
  if (missing.length) importAll(JSON.stringify(missing));
}

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
    nodeGraph: (graph: Graph, media: UrlMediaEntry[] = []) => {
      importNodeMedia(media);
      setCpm(registerLiveGraph(graph));
    },
    nodeGraphValues: (graph: Graph, media: UrlMediaEntry[] = []) => {
      importNodeMedia(media);
      return readLiveGraph(graph);
    },
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
  nodeTransport.advance(cycle, cps, rafAbsNow);
  if (mode === "nodes") {
    liveMotions.advance(cycle);
    nodeEditor.setTimeRate(cps);
  }
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
  if (!nodeEditor.isMovingGraph) {
    previews.draw(nodeEditor.previewGraph, () => nodeEditor.visiblePreviews(), rafAbsNow, cycle, cps, canvas.width / canvas.height, nodeEditor.previewNode);
  }
}
document.addEventListener("visibilitychange", scheduleFrame);

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
  nodeTransport.advance(cycle, cps, wall);
  frameRenderer.render(evalController.screens, evalController.namedScreens, t, cps, cycle, wall);
  projection.present(canvas);
};

// --- URL state ---
let currentCode = defaultCode;
export function getCurrentCode(): string { return currentCode; }

await textureLibraryReady;
const urlState = loadFromUrl();
const savedNodes = loadNodes();
const initialGraph = savedNodes?.draft ?? starterGraph();
const session: NodeSession = savedNodes ?? {
  draft: initialGraph,
  view: { x: 0, y: 0, zoom: 1, previews: [initialGraph.nodes[0].id] },
  media: [],
};
let mode: "nodes" | "code" = urlState ? "code" : "nodes";
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
} else {
  // Fresh session: greet the visitor with a random autostart-eligible example,
  // paired with the CDN defaults the media loader auto-pulls. Flashing examples
  // are excluded via `autostart: false`. Source names resolve at query time, so
  // it renders once the async defaults land — no re-eval needed.
  currentCode = pickAutostartCode() || defaultCode;
  if (savedNodes) {
    initRegistry(savedNodes.media);
    if (savedNodes.fft) applyFftConfig(savedNodes.fft);
  }
}

setUrlWarnCallback((msg) => { if (msg) warn(msg); });
function saveWorkspace() {
  if (mode === "nodes") {
    session.media = persistableMedia(getAllEntries());
    session.fft = getFftConfig();
    saveNodes(session);
  } else saveToUrl(currentCode, getAllEntries(), getFftConfig());
}

// --- editor ---
const codeEditor = setupEditor(
  document.getElementById("editor-wrap")!,
  currentCode,
  (code) => {
    currentCode = code;
    saveWorkspace();
  },
  mode === "code",
);

const nodeHost = document.getElementById("node-editor")!;
const codeBar = document.getElementById("nd-code-bar")!;
function showWorkspace(next: typeof mode) {
  mode = next;
  document.body.classList.toggle("nd-mode", next === "nodes");
  nodeHost.hidden = next !== "nodes";
  codeBar.hidden = next !== "code";
  projection.setWorkspace(next === "nodes");
  if (next === "nodes") {
    cancelUrlSave();
    nodeEditor.refresh();
    // A code share hash opens the text workspace. Clear it when explicitly switching to nodes.
    if (loadFromUrl()) history.replaceState(null, "", location.pathname + location.search);
  } else {
    codeEditor.requestMeasure();
    codeEditor.focus();
  }
  measureSidebar();
}

const nodeEditor = new NodeEditor(nodeHost, {
  graph: session.draft,
  view: session.view,
  save: graph => { session.draft = graph; saveWorkspace(); },
  setTempo: tempo => {
    if (session.live?.nodes.some(node => node.kind === "tempo")) return;
    const now = performance.now();
    const frame = cpsController.tick(now);
    nodeTransport.advance(frame.cycle, tempo / 60, now);
    cpsController.setCpm(tempo, now);
    nodeEditor.setTimeRate(tempo / 60);
    if (session.live) session.live = { ...session.live, tempo };
  },
  setMotionFactor: (id, input, value) => {
    if (!session.live) return false;
    const cycle = cpsController.tick(performance.now()).cycle;
    if (!liveMotions.setFactor(id, input, cycle, value)) return false;
    const live = session.live;
    session.live = { ...live, nodes: live.nodes.map(node => node.id === id ? { ...node, data: { ...node.data, [input]: value } } : node) };
    return true;
  },
  run: (graph, restart) => {
    try {
      const now = performance.now();
      const phase = cpsController.tick(now);
      const motions = new NodeMotions(restart ? undefined : liveMotions, restart ? 0 : phase.cycle);
      const next = compileLiveGraph(graph, nodeTransport, motions);
      if (restart) {
        cpsController.reset(now);
        nodeTransport.reset(now);
      } else nodeTransport.advance(phase.cycle, phase.cps, now);
      liveMotions = motions;
      restoreRegistry(next.registry);
      cpsController.setCpm(next.tempo, now);
      evalController.screens = next.screens;
      evalController.namedScreens = next.namedScreens;
      session.live = graph;
      saveWorkspace();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
  showCode: () => showWorkspace("code"),
  exportCode: graph => {
    const code = exportNodeCode(graph, getAllEntries());
    showWorkspace("code");
    if (code === currentCode) saveWorkspace();
    else setCode(code);
  },
  openReference: entry => sidebarControls.openReference(entry),
  openOutput: () => projection.open(),
  bindProjectionToggle: button => projection.bindToggle(button),
});

document.getElementById("nd-show-nodes")!.addEventListener("click", () => showWorkspace("nodes"));
document.getElementById("nd-code-output")!.addEventListener("click", () => projection.open());

const setCode = window.pdSetCode;
window.pdSetCode = (code, evaluate) => { showWorkspace("code"); setCode(code, evaluate); };
const insertCode = window.pdInsertAtCursor;
window.pdInsertAtCursor = name => {
  const medium = mode === "nodes" ? resolveMedia(name) : undefined;
  if (medium) nodeEditor.addMedia(medium);
  else if (mode === "code") insertCode(name);
};

const sidebar = document.getElementById("sidebar-panel")!;
function measureSidebar() {
  const inset = sidebar.classList.contains("open") && innerWidth > 680 ? sidebar.offsetWidth + 24 : 24;
  document.body.style.setProperty("--nd-sidebar", `${inset}px`);
}
new ResizeObserver(measureSidebar).observe(sidebar);
new MutationObserver(measureSidebar).observe(sidebar, { attributes: true, attributeFilter: ["class"] });
const sidebarControls = setupSidebar(!urlState && !savedNodes, mode === "nodes" ? "videos" : undefined, example => {
  showWorkspace("nodes");
  nodeEditor.loadExample(createExampleGraph(example.name));
  void loadExampleMedia(example.media ?? []);
});
addOnChange(() => { nodeEditor.mediaChanged(); saveWorkspace(); });
onTextureLibraryChange(() => nodeEditor.mediaChanged());
onFftConfigChange(saveWorkspace);
showWorkspace(mode);
if (mode === "nodes") nodeEditor.run(session.live ?? (savedNodes ? starterGraph() : initialGraph));
window.addEventListener("pagehide", () => previews.dispose());
scheduleFrame();
