import { demo, projectFromJson, textures, type Project } from "./graph";
import type { Renderer } from "./gpu";
import type { RemoteAsset } from "./video-library";

export interface LocalAsset { id: string; name: string; file: Blob }
export type Asset = LocalAsset | RemoteAsset;
export const isTextureAsset = (asset: Asset) => "file" in asset
  ? asset.file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif)$/i.test(asset.name)
  : asset.type === "image";

export const captureSources = {
  webcam: { id: "capture:webcam", name: "Webcam" },
  screen: { id: "capture:screen", name: "Screen" },
} as const;
export type CaptureKind = keyof typeof captureSources;
export const captureKinds = Object.keys(captureSources) as CaptureKind[];

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

export class Storage {
  private readonly db: Promise<IDBDatabase>;
  constructor() {
    const connection = indexedDB.open("nodesdevil-compositor", 1);
    connection.onupgradeneeded = () => {
      connection.result.createObjectStore("assets", { keyPath: "id" });
      connection.result.createObjectStore("projects");
    };
    this.db = request(connection);
  }

  async list(): Promise<Asset[]> {
    return request((await this.db).transaction("assets").objectStore("assets").getAll());
  }

  async add(file: File): Promise<LocalAsset> {
    const asset = { id: crypto.randomUUID(), name: file.name, file };
    await this.remember(asset);
    return asset;
  }

  async remember(asset: Asset) {
    await this.write(["assets"], tx => tx.objectStore("assets").put(asset));
  }

  async save(project: Project, remote: RemoteAsset[] = []) {
    await this.write(["projects", "assets"], tx => {
      tx.objectStore("projects").put(project, "saved");
      for (const asset of remote) tx.objectStore("assets").put(asset);
    });
  }

  async load() {
    const value: unknown = await request((await this.db).transaction("projects").objectStore("projects").get("saved"));
    return value === undefined ? undefined : projectFromJson(value);
  }

  private async write(stores: string[], update: (tx: IDBTransaction) => void) {
    const tx = (await this.db).transaction(stores, "readwrite");
    update(tx);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }
}

interface Clip { video: HTMLVideoElement; objectUrl?: string; texture?: GPUTexture; frame: number; uploaded: number; callback: number }
interface Still { image: HTMLImageElement; texture?: GPUTexture; objectUrl?: string }

export class Media {
  readonly assets = new Map<string, Asset>();
  readonly failed = new Set<string>();
  private readonly clips = new Map<string, Clip>();
  private readonly stills = new Map<string, Still>();
  private readonly streams = new Map<string, MediaStream>();
  private needed = new Set<string>();
  private captureGeneration = 0;
  private videoCanvas?: CanvasRenderingContext2D;
  onDecode?: (durationMs: number) => void;
  onError?: (asset: string, message: string) => void;
  onCaptureChange?: () => void;

  constructor(private readonly renderer: Renderer) {}

  name(id: string) { return this.assets.get(id)?.name ?? demo[id as keyof typeof demo]?.name ?? textures.get(id)?.name ??
    captureKinds.map(kind => captureSources[kind]).find(source => source.id === id)?.name ?? "Missing media"; }
  has(id: string) { return this.assets.has(id) || Object.hasOwn(demo, id) || textures.has(id) || this.isCapture(id); }
  times() { return Object.fromEntries([...this.clips].map(([id, clip]) => [id, clip.video.currentTime])); }
  isCapture(id: string) { return captureKinds.some(kind => captureSources[kind].id === id); }
  captureActive(id: string) { return this.streams.has(id); }

  async startCapture(kind: CaptureKind) {
    const { id, name } = captureSources[kind];
    if (this.streams.has(id)) return;
    const generation = this.captureGeneration;
    const devices = navigator.mediaDevices;
    if (!devices || kind === "screen" && !devices.getDisplayMedia) throw new Error(`${name} capture is unavailable in this browser.`);
    const stream = kind === "screen" ? await devices.getDisplayMedia({ video: true, audio: false })
      : await devices.getUserMedia({ video: true, audio: false });
    const track = stream.getVideoTracks().find(track => track.readyState === "live");
    if (!track || generation !== this.captureGeneration || this.streams.has(id)) {
      stream.getTracks().forEach(track => track.stop());
      if (!track) throw new Error(`${name} did not provide a video track.`);
      return;
    }
    this.streams.set(id, stream);
    this.failed.delete(id);
    track.addEventListener("ended", () => { if (this.streams.get(id) === stream) this.stopCapture(kind); }, { once: true });
    if (this.needed.has(id)) this.loadClip(id, stream);
    this.onCaptureChange?.();
  }

  stopCapture(kind: CaptureKind) {
    const { id, name } = captureSources[kind];
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    this.releaseClip(id);
    stream.getTracks().forEach(track => track.stop());
    if (this.needed.has(id)) this.onError?.(id, `${name} capture stopped. Start it again in Videos.`);
    this.onCaptureChange?.();
  }

  stopCaptures() {
    this.captureGeneration++;
    captureKinds.forEach(kind => this.stopCapture(kind));
  }

  use(ids: Set<string>) {
    this.needed = ids;
    for (const [id, still] of this.stills) {
      if (ids.has(id)) continue;
      this.stills.delete(id);
      this.failed.delete(id);
      still.texture?.destroy();
      if (still.objectUrl) URL.revokeObjectURL(still.objectUrl);
    }
    for (const id of this.clips.keys()) if (!ids.has(id)) this.releaseClip(id);
    for (const id of ids) {
      if (this.clips.has(id) || this.stills.has(id)) continue;
      const source = this.assets.get(id);
      const bundled = demo[id as keyof typeof demo];
      const stream = this.streams.get(id);
      if (stream) {
        this.loadClip(id, stream);
        continue;
      }
      if (textures.has(id) || source && isTextureAsset(source)) {
        this.loadStill(id, source);
        continue;
      }
      if (source && "file" in source) {
        const objectUrl = URL.createObjectURL(source.file);
        this.loadClip(id, objectUrl, objectUrl);
      } else if (source || bundled) {
        this.loadClip(id, source?.url ?? import.meta.env.BASE_URL + bundled.url);
      }
    }
  }

  private loadClip(id: string, source: string | MediaStream, objectUrl?: string) {
    const video = document.createElement("video");
    const clip: Clip = { video, objectUrl, frame: 0, uploaded: -1, callback: 0 };
    this.clips.set(id, clip);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    if (typeof source === "string") {
      if (!objectUrl) video.crossOrigin = "anonymous";
      video.loop = true;
      video.src = source;
    } else video.srcObject = source;
    const track: VideoFrameRequestCallback = (_now, metadata) => {
      if (this.clips.get(id) !== clip) return;
      clip.frame = metadata.presentedFrames;
      if (Number.isFinite(metadata.processingDuration)) this.onDecode?.(metadata.processingDuration! * 1000);
      clip.callback = video.requestVideoFrameCallback(track);
    };
    clip.callback = video.requestVideoFrameCallback(track);
    video.addEventListener("error", () => { if (this.clips.get(id) === clip) this.fail(id, "Cannot load video"); });
    void video.play().catch(error => {
      if (this.clips.get(id) === clip && !this.failed.has(id)) this.fail(id, `Cannot play video (${error.message})`);
    });
  }

  private releaseClip(id: string) {
    const clip = this.clips.get(id);
    if (!clip) return;
    this.clips.delete(id);
    this.failed.delete(id);
    clip.video.cancelVideoFrameCallback(clip.callback);
    clip.video.pause();
    clip.video.srcObject = null;
    clip.video.removeAttribute("src");
    clip.video.load();
    clip.texture?.destroy();
    if (clip.objectUrl) URL.revokeObjectURL(clip.objectUrl);
  }

  private loadStill(id: string, source?: Asset) {
    const image = new Image();
    const objectUrl = source && "file" in source ? URL.createObjectURL(source.file) : undefined;
    if (source && "url" in source) image.crossOrigin = "anonymous";
    const still: Still = { image, objectUrl };
    this.stills.set(id, still);
    image.onload = () => {
      if (this.stills.get(id) !== still) return;
      const size = [image.naturalWidth, image.naturalHeight] as const;
      if (size.some(side => side > this.renderer.device.limits.maxTextureDimension2D)) {
        this.fail(id, "Texture exceeds the GPU size limit");
        return;
      }
      still.texture = this.renderer.texture(...size);
      this.renderer.device.queue.copyExternalImageToTexture({ source: image }, { texture: still.texture }, size);
    };
    image.onerror = () => { if (this.stills.get(id) === still) this.fail(id, "Cannot decode"); };
    image.src = still.objectUrl ?? (source && "url" in source ? source.url : import.meta.env.BASE_URL + id);
  }

  private fail(id: string, reason: string) {
    this.failed.add(id);
    this.onError?.(id, `${reason}: ${this.name(id)}.`);
  }

  upload() {
    for (const clip of this.clips.values()) {
      const { video } = clip;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || clip.uploaded === clip.frame || !video.videoWidth) continue;
      const { videoWidth: width, videoHeight: height } = video;
      if (clip.texture?.width !== width || clip.texture?.height !== height) {
        clip.texture?.destroy();
        clip.texture = this.renderer.texture(width, height);
      }
      this.copyVideoFrame(video, clip.texture!, [width, height]);
      clip.uploaded = clip.frame;
    }
  }

  private copyVideoFrame(video: HTMLVideoElement, texture: GPUTexture, size: readonly [number, number]) {
    const queue = this.renderer.device.queue;
    if (!this.videoCanvas) {
      try {
        queue.copyExternalImageToTexture({ source: video }, { texture }, size);
        return;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        // Some implementations expose the method before supporting video sources.
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw error;
        this.videoCanvas = context;
      }
    }
    const context = this.videoCanvas;
    const { canvas } = context;
    const [width, height] = size;
    if (canvas.width < width) canvas.width = width;
    if (canvas.height < height) canvas.height = height;
    context.globalCompositeOperation = "copy";
    context.drawImage(video, 0, 0, width, height);
    queue.copyExternalImageToTexture({ source: canvas }, { texture }, size);
  }

  texture = (id: string) => this.clips.get(id)?.texture ?? this.stills.get(id)?.texture;
}
