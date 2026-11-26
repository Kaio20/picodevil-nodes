import { demo, projectFromJson, type Project } from "./graph";
import type { Renderer } from "./gpu";

export interface LocalAsset { id: string; name: string; file: Blob }

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

  async list(): Promise<LocalAsset[]> {
    return request((await this.db).transaction("assets").objectStore("assets").getAll());
  }

  async add(file: File): Promise<LocalAsset> {
    const asset = { id: crypto.randomUUID(), name: file.name, file };
    await this.write("assets", store => store.put(asset));
    return asset;
  }

  async save(project: Project) { await this.write("projects", store => store.put(project, "saved")); }

  async load() {
    const value: unknown = await request((await this.db).transaction("projects").objectStore("projects").get("saved"));
    return value === undefined ? undefined : projectFromJson(value);
  }

  private async write(name: string, update: (store: IDBObjectStore) => void) {
    const tx = (await this.db).transaction(name, "readwrite");
    update(tx.objectStore(name));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }
}

interface Clip { video: HTMLVideoElement; url: string; local: boolean; texture?: GPUTexture; frame: number; uploaded: number; callback: number }

export class Media {
  readonly assets = new Map<string, LocalAsset>();
  readonly failed = new Set<string>();
  private readonly clips = new Map<string, Clip>();
  onDecode?: (durationMs: number) => void;
  onError?: (asset: string, message: string) => void;

  constructor(private readonly renderer: Renderer) {}

  name(id: string) { return this.assets.get(id)?.name ?? demo[id as keyof typeof demo]?.name ?? "Missing video"; }
  times() { return Object.fromEntries([...this.clips].map(([id, clip]) => [id, clip.video.currentTime])); }

  use(ids: Set<string>) {
    for (const [id, clip] of this.clips) {
      if (ids.has(id)) continue;
      clip.video.cancelVideoFrameCallback(clip.callback);
      clip.video.pause();
      clip.video.removeAttribute("src");
      clip.video.load();
      clip.texture?.destroy();
      if (clip.local) URL.revokeObjectURL(clip.url);
      this.clips.delete(id);
      this.failed.delete(id);
    }
    for (const id of ids) {
      if (this.clips.has(id)) continue;
      const local = this.assets.get(id);
      const bundled = demo[id as keyof typeof demo];
      if (!local && !bundled) continue;
      const url = local ? URL.createObjectURL(local.file) : import.meta.env.BASE_URL + bundled.url;
      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      const clip: Clip = { video, url, local: Boolean(local), frame: 0, uploaded: -1, callback: 0 };
      this.clips.set(id, clip);
      const track: VideoFrameRequestCallback = (_now, metadata) => {
        clip.frame = metadata.presentedFrames;
        if (Number.isFinite(metadata.processingDuration)) this.onDecode?.(metadata.processingDuration! * 1000);
        clip.callback = video.requestVideoFrameCallback(track);
      };
      clip.callback = video.requestVideoFrameCallback(track);
      video.addEventListener("error", () => {
        if (this.clips.get(id) !== clip) return;
        this.failed.add(id);
        this.onError?.(id, `Cannot decode ${this.name(id)}.`);
      });
      video.src = url;
      void video.play().catch(() => {
        if (this.clips.get(id) === clip && video.error) this.onError?.(id, `Cannot play ${this.name(id)}.`);
      });
    }
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
      this.renderer.device.queue.copyExternalImageToTexture(
        { source: video }, { texture: clip.texture! }, [width, height],
      );
      clip.uploaded = clip.frame;
    }
  }

  texture = (id: string) => this.clips.get(id)?.texture;
}
