import { compile } from "./compiler";
import { type FrameTime, type PreparedPlan, Renderer, type Surface } from "./gpu";
import { GraphError, type Project } from "./graph";
import { Media } from "./media";
import { AudioInput } from "./audio";

const WIDTH = 1920, HEIGHT = 1080;
export interface Metrics {
  started: number; outputFrames: number; skipped: number;
  uploads: number[]; decode: number[]; program: number[]; preview: number[]; work: number[]; completion: number[]; intervals: number[];
}
interface Candidate { project: Project; program?: PreparedPlan; viewer?: PreparedPlan; viewerShowsOutput: boolean; error?: Error; viewerError?: Error }
interface Take { project: Project; program: PreparedPlan }
interface Output {
  window: Window;
  context: CanvasRenderingContext2D;
  stage: HTMLCanvasElement;
  surface: Surface;
  status: HTMLElement;
  presented: boolean;
}

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
  readonly audio = new AudioInput();
  readonly transport = new Transport();
  metrics?: Metrics;
  previewEnabled = true;
  onChange?: () => void;
  onPreview?: (beats: number, audio: readonly number[]) => void;
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
  private output?: Output;
  private startOnOpen?: () => boolean;
  private readonly viewer: Surface;
  private mini?: { canvas: HTMLCanvasElement; surface: Surface };

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
      this.updateOutputStatus();
      this.onChange?.();
    };
    renderer.device.lost.then(info => {
      this.deviceLost = true;
      this.message = `WebGPU device lost: ${info.message}. Reload the editor.`;
      this.updateOutputStatus();
      this.onChange?.();
    });
    document.addEventListener("visibilitychange", this.reschedule);
    window.addEventListener("pagehide", () => {
      this.audio.stop();
      this.media.stopCaptures();
      this.output?.window.close();
    });
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
        if (!this.media.has(asset)) throw new GraphError("Media source is missing. Select or import an asset.", id);
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
    this.tryStartOutput();
    this.updateOutputStatus();
    this.onChange?.();
  }

  take() {
    if (this.preparing || !this.draft?.program) return false;
    const assets = Object.values(this.draft.program.plan.media);
    const stopped = assets.find(asset => this.media.isCapture(asset) && !this.media.captureActive(asset));
    if (stopped) {
      this.message = `Start ${this.media.name(stopped)} in Videos before Take.`;
      this.updateOutputStatus();
      this.onChange?.();
      return false;
    }
    const broken = assets.find(asset => this.media.failed.has(asset));
    if (broken) {
      this.message = `Cannot decode ${this.media.name(broken)}.`;
      this.updateOutputStatus();
      this.onChange?.();
      return false;
    }
    const previous = this.pending?.program;
    this.message = "";
    this.startOnOpen = undefined;
    this.pending = { project: this.draft.project, program: this.draft.program };
    this.release(previous);
    this.syncMedia();
    this.updateOutputStatus();
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

  setMini(canvas?: HTMLCanvasElement) {
    if (canvas === this.mini?.canvas) return;
    this.mini?.surface.context.unconfigure();
    this.mini = canvas ? { canvas, surface: this.renderer.surface(canvas) } : undefined;
  }

  openOutput(draftIsCurrent: () => boolean) {
    if (this.output && !this.output.window.closed) { this.output.window.focus(); return true; }
    this.detachOutput();
    const popup = window.open("", "_blank", "popup,width=960,height=540");
    if (!popup) return false;
    let output: Output;
    try {
      const canvas = popup.document.createElement("canvas");
      const stage = document.createElement("canvas");
      canvas.width = stage.width = WIDTH;
      canvas.height = stage.height = HEIGHT;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not configure the output canvas.");
      // Keep the GPU surface in the editor's document and present its frames in the popup.
      output = { window: popup, context, stage, surface: this.renderer.surface(stage), status: popup.document.createElement("p"), presented: false };
    } catch (error) {
      popup.close();
      throw error;
    }
    const { canvas } = output.context;
    popup.document.title = "NodesDevil Live Output";
    popup.document.body.style.cssText = "margin:0;background:#000;display:grid;place-items:center;height:100vh;overflow:hidden";
    canvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
    canvas.setAttribute("aria-label", "Live Output. Double-click for fullscreen.");
    output.status.style.cssText = "position:fixed;top:50%;left:1rem;right:1rem;margin:0;transform:translateY(-50%);color:#ddd;font:15px system-ui;text-align:center";
    output.status.setAttribute("role", "status");
    popup.document.body.replaceChildren(canvas, output.status);
    canvas.addEventListener("dblclick", () => {
      const operation = popup.document.fullscreenElement ? popup.document.exitFullscreen() : canvas.requestFullscreen();
      void operation.catch(() => {});
    });
    popup.addEventListener("pagehide", () => {
      if (this.output !== output) return;
      this.detachOutput();
      this.reschedule();
    }, { once: true });
    popup.document.addEventListener("visibilitychange", this.reschedule);
    this.output = output;
    this.startOnOpen = !this.live && !this.pending ? draftIsCurrent : undefined;
    this.tryStartOutput();
    this.updateOutputStatus();
    this.reschedule();
    return true;
  }

  private tryStartOutput() {
    if (!this.startOnOpen?.() || this.preparing || !this.draft) return;
    this.startOnOpen = undefined;
    if (this.output && !this.output.window.closed && !this.live && !this.pending) this.take();
  }

  private updateOutputStatus() {
    const output = this.output;
    if (!output || output.window.closed) return;
    output.status.hidden = output.presented && !this.deviceLost;
    if (output.status.hidden) return;
    const message = this.message || (this.pending ? "Waiting for the live sources…" :
      this.startOnOpen || this.preparing || this.live ? "Preparing live output…" :
      this.draft?.error?.message ?? "Press Take in the editor to start the live output.");
    if (output.status.textContent !== message) output.status.textContent = message;
  }

  private detachOutput() {
    this.output?.surface.context.unconfigure();
    this.output = undefined;
    this.startOnOpen = undefined;
  }

  private reschedule = () => {
    if (this.frame && !this.frame.host.closed) this.frame.host.cancelAnimationFrame(this.frame.id);
    this.frame = undefined;
    this.schedule();
  };

  private schedule() {
    if (this.deviceLost || this.frame) return;
    if (this.output?.window.closed) this.detachOutput();
    const host = this.output && !this.output.window.document.hidden ? this.output.window : window;
    const frame = { host, id: 0 };
    frame.id = host.requestAnimationFrame(() => {
      if (this.frame !== frame) return;
      this.frame = undefined;
      try { this.tick(performance.now()); }
      catch (issue) {
        const message = issue instanceof Error ? issue.message : String(issue);
        if (message !== this.message) {
          this.message = message;
          this.updateOutputStatus();
          this.onChange?.();
        }
      }
      this.schedule();
    });
    this.frame = frame;
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
    const audio = this.audio.values();
    const time = { ...this.transport.at(now), audio };
    const encoder = this.renderer.device.createCommandEncoder();
    const popup = this.output && !this.output.window.closed && !this.output.window.document.hidden ? this.output : undefined;
    let drew = false;
    let output: GPUTexture | undefined;
    const liveStart = performance.now();
    if (this.live) {
      output = this.renderer.draw(encoder, this.live.program, time, this.media.texture);
      if (popup) this.renderer.show(encoder, popup.surface, output);
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
      const previewTime = this.transport.preview(now);
      const image = output && this.draft?.viewerShowsOutput && this.draft.project === this.live?.project
        ? output : this.renderer.draw(encoder, viewer, { ...previewTime, audio }, this.media.texture);
      this.renderer.show(encoder, this.viewer, image);
      if (this.mini && !this.preparing) this.renderer.show(encoder, this.mini.surface, image);
      this.onPreview?.(previewTime.beats, audio);
      this.previewAt = now + 31;
      metrics?.preview.push(performance.now() - begin);
      drew = true;
    }
    if (drew) {
      this.renderer.device.queue.submit([encoder.finish()]);
      this.busy++;
      void this.renderer.device.queue.onSubmittedWorkDone().then(() => {
        if (metrics && this.metrics === metrics) metrics.completion.push(performance.now() - start);
      }, () => {}).finally(() => this.busy--);
      if (popup && output) {
        popup.context.drawImage(popup.stage, 0, 0);
        if (!popup.presented) {
          popup.presented = true;
          this.updateOutputStatus();
        }
      }
      metrics?.work.push(performance.now() - start);
    }
  }
}
