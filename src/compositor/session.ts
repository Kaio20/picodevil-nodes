import { compile } from "./compiler";
import { type FrameTime, type PreparedPlan, Renderer, type Surface } from "./gpu";
import { demo, GraphError, type Project } from "./graph";
import { Media } from "./media";

const WIDTH = 1920, HEIGHT = 1080;
export interface Metrics {
  started: number; outputFrames: number; skipped: number;
  uploads: number[]; decode: number[]; program: number[]; preview: number[]; work: number[]; completion: number[]; intervals: number[];
}
interface Candidate { project: Project; program?: PreparedPlan; viewer?: PreparedPlan; viewerShowsOutput: boolean; error?: Error; viewerError?: Error }
interface Take { project: Project; program: PreparedPlan }

export class Transport {
  private readonly start = performance.now();
  private beatAnchor = this.start;
  private beatOffset = 0;
  private bpm = 120;
  private draft?: { bpm: number; anchor: number; offset: number };

  at(now: number): FrameTime {
    return { seconds: (now - this.start) / 1000, beats: this.beatOffset + (now - this.beatAnchor) * this.bpm / 60000 };
  }

  tempo(bpm: number, now: number) {
    if (bpm === this.bpm) return;
    this.beatOffset = this.at(now).beats;
    this.beatAnchor = now;
    this.bpm = bpm;
  }

  draftTempo(bpm: number, now: number) {
    if (bpm === this.bpm) { this.draft = undefined; return; }
    if (this.draft?.bpm !== bpm) this.draft = { bpm, anchor: now, offset: this.at(now).beats };
  }

  preview(now: number): FrameTime {
    const time = this.at(now);
    const draft = this.draft;
    if (draft) time.beats = draft.offset + (now - draft.anchor) * draft.bpm / 60000;
    return time;
  }
}

export class Session {
  readonly media: Media;
  readonly transport = new Transport();
  metrics?: Metrics;
  previewEnabled = true;
  onChange?: () => void;
  message = "";
  draft?: Candidate;
  live?: Take;
  pending?: Take;
  preparing = false;
  private generation = 0;
  private busy = 0;
  private previewAt = 0;
  private outputAt = 0;
  private deviceLost = false;
  private frame?: { host: Window; id: number };
  private output?: { window: Window; surface: Surface };
  private readonly viewer: Surface;

  constructor(readonly renderer: Renderer, canvas: HTMLCanvasElement) {
    this.viewer = renderer.surface(canvas);
    this.media = new Media(renderer);
    this.media.onDecode = duration => this.metrics?.decode.push(duration);
    this.media.onError = (asset, message) => {
      if (this.pending && Object.values(this.pending.program.plan.media).includes(asset)) {
        const previous = this.pending.program;
        this.pending = undefined;
        this.release(previous);
        this.syncMedia();
      }
      this.message = message;
      this.onChange?.();
    };
    renderer.device.lost.then(info => {
      this.deviceLost = true;
      this.message = `WebGPU device lost: ${info.message}. Reload the editor.`;
      this.onChange?.();
    });
    document.addEventListener("visibilitychange", this.reschedule);
    this.schedule();
  }

  beginMetrics() {
    this.outputAt = 0;
    this.metrics = { started: performance.now(), outputFrames: 0, skipped: 0, uploads: [], decode: [], program: [], preview: [], work: [], completion: [], intervals: [] };
  }

  endMetrics() {
    const result = this.metrics;
    this.metrics = undefined;
    return result;
  }

  async update(project: Project, selection?: string) {
    const generation = ++this.generation;
    this.preparing = true;
    this.message = "";
    this.onChange?.();
    const prepare = async (target?: string, width = WIDTH, height = HEIGHT) => {
      const plan = compile(project, target);
      for (const [id, asset] of Object.entries(plan.media)) {
        if (!Object.hasOwn(demo, asset) && !this.media.assets.has(asset)) throw new GraphError("Video source is missing. Select or import a clip.", id);
      }
      return this.renderer.prepare(plan, width, height);
    };
    const existing = this.draft?.project === project ? this.draft.program : undefined;
    const [ready, viewer] = await Promise.allSettled([existing ?? prepare(), prepare(selection, 640, 360)]);
    const result = (outcome: PromiseSettledResult<PreparedPlan>) => outcome.status === "fulfilled" ? outcome.value : undefined;
    const error = (outcome: PromiseSettledResult<PreparedPlan>) => outcome.status === "rejected" ?
      outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)) : undefined;
    const next = { project, program: result(ready), viewer: result(viewer), viewerShowsOutput: !selection || project.nodes.some(item => item.id === selection && item.kind === "output"),
      error: error(ready), viewerError: error(viewer) };
    if (generation !== this.generation) {
      this.release(next.program, next.viewer);
      return;
    }
    const prior = this.draft;
    this.draft = next;
    this.transport.draftTempo(project.bpm, performance.now());
    this.preparing = false;
    this.release(prior?.program, prior?.viewer);
    this.syncMedia();
    this.onChange?.();
  }

  take() {
    if (this.preparing || !this.draft?.program) return false;
    const broken = Object.values(this.draft.program.plan.media).find(asset => this.media.failed.has(asset));
    if (broken) { this.message = `Cannot decode ${this.media.name(broken)}.`; this.onChange?.(); return false; }
    const previous = this.pending?.program;
    this.pending = { project: this.draft.project, program: this.draft.program };
    this.release(previous);
    this.syncMedia();
    this.onChange?.();
    return true;
  }

  private release(...plans: (PreparedPlan | undefined)[]) {
    const retained = new Set([this.draft?.program, this.draft?.viewer, this.live?.program, this.pending?.program]);
    for (const plan of new Set(plans)) if (plan && !retained.has(plan)) plan.dispose();
  }

  private syncMedia() {
    const active = [this.live?.program, this.pending?.program, this.draft?.program, this.draft?.viewer];
    this.media.use(new Set(active.flatMap(item => item ? Object.values(item.plan.media) : [])));
  }

  openOutput() {
    if (this.output && !this.output.window.closed) { this.output.window.focus(); return true; }
    const popup = window.open("", "nodesdevil-compositor-output", "popup,width=960,height=540");
    if (!popup) return false;
    popup.document.title = "NodesDevil Live Output";
    popup.document.body.style.cssText = "margin:0;background:#000;display:grid;place-items:center;height:100vh;overflow:hidden";
    const canvas = popup.document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
    canvas.setAttribute("aria-label", "Live Output. Double-click for fullscreen.");
    popup.document.body.replaceChildren(canvas);
    canvas.addEventListener("dblclick", () => {
      const operation = popup.document.fullscreenElement ? popup.document.exitFullscreen() : canvas.requestFullscreen();
      void operation.catch(() => {});
    });
    popup.addEventListener("pagehide", this.reschedule);
    popup.document.addEventListener("visibilitychange", this.reschedule);
    this.output = { window: popup, surface: this.renderer.surface(canvas) };
    this.reschedule();
    return true;
  }

  private reschedule = () => {
    if (this.frame) this.frame.host.cancelAnimationFrame(this.frame.id);
    this.schedule();
  };

  private schedule() {
    if (this.deviceLost) return;
    if (this.output?.window.closed) this.output = undefined;
    const host = this.output && !this.output.window.document.hidden ? this.output.window : window;
    this.frame = { host, id: host.requestAnimationFrame(() => {
      try { this.tick(performance.now()); }
      catch (issue) {
        const message = issue instanceof Error ? issue.message : String(issue);
        if (message !== this.message) { this.message = message; this.onChange?.(); }
      }
      this.schedule();
    }) };
  }

  private tick(now: number) {
    const metrics = this.metrics;
    if (this.busy >= 2) { if (metrics && this.live) metrics.skipped++; return; }
    if (!this.live && !this.pending && !this.draft?.viewer) return;
    const start = performance.now();
    this.media.upload();
    if (metrics) metrics.uploads.push(performance.now() - start);
    if (this.pending && Object.values(this.pending.program.plan.media).every(asset => this.media.texture(asset))) {
      const previous = this.live?.program;
      this.live = this.pending;
      this.pending = undefined;
      this.transport.tempo(this.live.project.bpm, now);
      this.transport.draftTempo(this.draft?.project.bpm ?? this.live.project.bpm, now);
      this.release(previous);
      this.syncMedia();
      this.onChange?.();
    }
    const time = this.transport.at(now);
    const encoder = this.renderer.device.createCommandEncoder();
    let drew = false;
    let output: GPUTexture | undefined;
    const liveStart = performance.now();
    if (this.live) {
      output = this.renderer.draw(encoder, this.live.program, time, this.media.texture);
      if (this.output) this.renderer.show(encoder, this.output.surface, output);
      if (metrics) {
        metrics.program.push(performance.now() - liveStart);
        metrics.outputFrames++;
        if (this.outputAt) metrics.intervals.push(now - this.outputAt);
        this.outputAt = now;
      }
      drew = true;
    }
    const viewer = this.draft?.viewer;
    if (viewer && this.previewEnabled && !document.hidden && this.busy === 0 && now >= this.previewAt && performance.now() - start < 8) {
      const begin = performance.now();
      const image = output && this.draft?.viewerShowsOutput && this.draft.project === this.live?.project
        ? output : this.renderer.draw(encoder, viewer, this.transport.preview(now), this.media.texture);
      this.renderer.show(encoder, this.viewer, image);
      this.previewAt = now + 31;
      metrics?.preview.push(performance.now() - begin);
      drew = true;
    }
    if (drew) {
      this.renderer.device.queue.submit([encoder.finish()]);
      metrics?.work.push(performance.now() - start);
      this.busy++;
      void this.renderer.device.queue.onSubmittedWorkDone().then(() => {
        if (metrics && this.metrics === metrics) metrics.completion.push(performance.now() - start);
      }, () => {}).finally(() => this.busy--);
    }
  }
}
