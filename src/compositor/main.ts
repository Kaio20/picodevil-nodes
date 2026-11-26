import "./style.css";
import { colorCss, isColorValue, type ColorValue } from "../color-value";
import { analyze, attachNode, audioBands, connectPorts, demo, example, inputKey, insertNode, integerMax, integerMin,
  kinds, makeNode, nodes, projectFromJson, roundInteger, texturePacks, textures, typeNames, withJunctionTypes, GraphError,
  type Edge, type GraphNode, type Kind, type Port, type Project, type SocketType, type Value } from "./graph";
import { catalog, groups, nodeDrag, readDrop, type Drop, type Group } from "./catalog";
import { bindNumberDrag, trackPointerDrag } from "../node-number-input";
import { Renderer } from "./gpu";
import { captureKinds, captureSources, isTextureAsset, Storage, type Asset, type CaptureKind } from "./media";
import { setupReference } from "./reference";
import { Session } from "./session";
import { importMediaUrl, loadPicoDevilExamples, type RemoteAsset } from "./video-library";

function el<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
function make<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className?: string) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function button(text: string, action: () => void, cls?: string) {
  const item = make("button", text, cls);
  item.type = "button";
  item.onclick = action;
  return item;
}

const svg = "http://www.w3.org/2000/svg";
type Point = { x: number; y: number };
type Attach = (project: Project, node: GraphNode) => Project | undefined;
type MenuContext = { point: Point; anchor: Point; attach?: Attach; cancel?: () => void; category?: Group; compatible: Kind[]; required: boolean };
const tabs = { videos: "media", textures: "textures", audio: "audio", reference: "reference" } as const;
type Tab = keyof typeof tabs;
const tabNames = Object.keys(tabs) as Tab[];
type VideoEntry = { id: string; name: string; kind: "video" | "texture"; thumbnail?: string; status?: string };

class Editor {
  private project = example();
  private selection?: string;
  private selectedEdge?: Edge;
  private viewer?: string;
  private mini?: string;
  private runtime?: Session;
  private unavailable = "";
  private note = "";
  private noteError = false;
  private updateTimer?: number;
  private zoom = 1;
  private pan: Point = { x: 22, y: 22 };
  private pending?: Port;
  private detached?: Edge;
  private compatibleSockets = new Set<HTMLElement>();
  private lastPoint?: Point;
  private hoveredEdge?: Edge;
  private insertion?: Edge;
  private menuContext?: MenuContext;
  private revealReference?: (kind: Kind) => void;
  private previous: Project[] = [];
  private next: Project[] = [];
  private readonly imageUrls = new Map<string, string>();
  private readonly graph = el("graph");
  private readonly scene = el("scene");
  private readonly wires = document.querySelector<SVGSVGElement>("#wires")!;
  private readonly cards = el("cards");
  private readonly menu = el<HTMLDialogElement>("node-menu");
  private readonly editorDialog = el<HTMLDialogElement>("node-editor-dialog");
  private readonly search = el<HTMLInputElement>("node-search");
  private readonly bpm = el<HTMLInputElement>("bpm");
  private readonly save = el<HTMLButtonElement>("save");
  private readonly load = el<HTMLButtonElement>("load");
  private readonly take = el<HTMLButtonElement>("take");
  private readonly storage = new Storage();
  private readonly assets = new Map<string, Asset>();
  private readonly capturePending = new Set<CaptureKind>();
  private readonly cardsById = new Map<string, HTMLElement>();
  private readonly outlets = new Map<string, HTMLButtonElement>();
  private readonly inlets = new Map<string, HTMLButtonElement>();
  private readonly wireElements = new Map<SVGPathElement, Edge>();

  constructor() {
    el("add-node").onclick = () => {
      const rect = this.graph.getBoundingClientRect();
      this.openMenu({ x: rect.left + 16, y: rect.top + 12 });
    };
    el("fit").onclick = () => this.fit();
    el("undo").onclick = () => this.restoreHistory(false);
    el("redo").onclick = () => this.restoreHistory(true);
    this.bpm.onchange = () => {
      const bpm = this.bpm.valueAsNumber;
      if (!Number.isFinite(bpm) || bpm < 1 || bpm > 480) { this.bpm.value = String(this.project.bpm); return; }
      this.edit({ ...this.project, bpm });
    };
    this.take.onclick = () => this.requestTake();
    this.save.onclick = () => {
      const sources = new Set(this.project.nodes.map(node => node.params.asset));
      const remote = [...this.assets.values()].filter((asset): asset is RemoteAsset => "url" in asset && sources.has(asset.id));
      void this.storage.save(this.project, remote).then(() => this.report("Project saved in this browser."), error => this.report(String(error), true));
    };
    this.load.onclick = () => { void this.storage.load().then(saved => {
      if (saved) this.loadProject(saved);
      this.report(saved ? "Saved project opened in Preview." : "No saved compositor project yet.");
    }, error => this.report(String(error), true)); };
    el("projection").onclick = () => {
      if (!this.runtime) return;
      try {
        if (!this.runtime.openOutput(() => this.updateTimer === undefined)) this.report("Could not open the output window. Allow pop-ups for this page.", true);
      } catch (error) {
        this.report(error instanceof Error ? error.message : String(error), true);
      }
    };
    el("view-output").onclick = () => {
      this.viewer = undefined;
      this.renderGraph();
      this.queueUpdate();
    };
    const files = el<HTMLInputElement>("files");
    el("import").onclick = () => files.click();
    files.onchange = () => { void this.importFiles([...files.files ?? []], undefined, "video"); files.value = ""; };
    const images = el<HTMLInputElement>("image-files");
    el("import-texture").onclick = () => images.click();
    images.onchange = () => { void this.importFiles([...images.files ?? []], undefined, "texture"); images.value = ""; };
    this.dropTarget(el("media"), event => this.importFiles([...event.dataTransfer!.files]));
    this.dropTarget(el("textures"), event => this.importFiles([...event.dataTransfer!.files], undefined, "texture"));
    this.dropTarget(this.graph, async event => {
      const data = event.dataTransfer!;
      const drop = readDrop(data.getData(nodeDrag));
      if (drop) this.dropNode(drop, event);
      else if (data.files.length) await this.importFiles([...data.files], this.inScene(event));
    });
    this.configureLibrary();
    this.search.oninput = () => {
      if (this.menuContext) this.menuContext.category = undefined;
      this.renderMenu();
    };
    this.search.onkeydown = event => {
      const first = el("node-results").querySelector("button") ??
        (this.search.value.trim() ? undefined : el("node-categories").querySelector("button"));
      if (event.key === "Enter") { event.preventDefault(); first?.click(); }
      if (event.key === "ArrowDown") { event.preventDefault(); first?.focus(); }
    };
    this.menu.addEventListener("cancel", event => { event.preventDefault(); this.closeMenu(); });
    this.menu.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.closeMenu(); }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.target instanceof HTMLButtonElement) {
        const items = [...event.target.parentElement!.querySelectorAll("button")];
        items[(items.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        event.preventDefault();
      }
    });
    document.addEventListener("pointerdown", event => {
      if (this.menu.open && !(event.target as Element).closest("#node-menu, #add-node")) this.closeMenu(false, false);
    });
    this.graph.addEventListener("wheel", event => {
      event.preventDefault();
      const point = this.inScene(event);
      const box = this.graph.getBoundingClientRect();
      this.zoom = Math.min(2, Math.max(0.14, this.zoom * Math.exp(-event.deltaY * 0.0015)));
      this.pan = { x: event.clientX - box.left - point.x * this.zoom, y: event.clientY - box.top - point.y * this.zoom };
      this.updateCamera();
    }, { passive: false });
    this.graph.addEventListener("pointerdown", event => this.startPan(event));
    this.graph.addEventListener("pointermove", event => {
      this.lastPoint = this.inScene(event);
      this.hoveredEdge = event.buttons ? undefined : this.edgeAt(event);
      if (this.pending && !event.buttons) this.renderWires();
    });
    this.graph.addEventListener("contextmenu", event => {
      if ((event.target as Element).closest(".node, .wire-hit, .node-menu")) return;
      event.preventDefault();
      this.openMenu({ x: event.clientX, y: event.clientY }, this.hoveredEdge);
    });
    this.graph.addEventListener("keydown", event => {
      if (event.target !== this.graph) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (this.selectedEdge) this.disconnect(this.selectedEdge.to, this.selectedEdge.input);
        else this.removeSelection();
      }
      if (event.key === "Escape") this.setPending();
      if (event.key.toLowerCase() === "a" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const { left, top } = this.scene.getBoundingClientRect();
        const point = this.lastPoint && { x: left + this.lastPoint.x * this.zoom, y: top + this.lastPoint.y * this.zoom };
        this.openMenu(point, this.hoveredEdge);
      }
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.requestTake(); }
      if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase()) &&
          !(event.target as Element).closest("input,textarea,select")) {
        event.preventDefault();
        this.restoreHistory(event.shiftKey || event.key.toLowerCase() === "y");
      }
    });
    new ResizeObserver(() => this.renderWires()).observe(this.graph);
    this.renderAssets();
    this.renderGraph();
    this.fit();
    void this.initialize();
    void this.loadVideoExamples();
  }

  private async initialize() {
    try {
      const renderer = await Renderer.create();
      this.runtime = new Session(renderer, el<HTMLCanvasElement>("preview"));
      for (const asset of this.assets.values()) this.runtime.media.assets.set(asset.id, asset);
      this.runtime.onChange = () => this.updateStatus();
      this.runtime.onPreview = (beats, audio) => this.animateControls(beats, audio);
      this.runtime.media.onCaptureChange = () => this.updateCaptureControls();
      this.syncMini();
      this.exposeMetrics();
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : String(error);
    }
    try {
      const assets = await this.storage.list();
      for (const asset of assets) {
        if (!this.assets.has(asset.id)) this.registerAsset(asset);
      }
      this.renderAssets();
      this.renderGraph();
    } catch (error) {
      this.report(`Storage unavailable: ${String(error)}`, true);
    }
    this.queueUpdate();
  }

  private exposeMetrics() {
    const session = this.runtime!;
    Object.assign(window, { compositor: {
      adapter: () => ({ vendor: session.renderer.adapter.info.vendor, device: session.renderer.adapter.info.device,
        description: session.renderer.adapter.info.description, fallback: session.renderer.adapter.info.isFallbackAdapter }),
      begin: () => session.beginMetrics(),
      end: () => session.endMetrics(),
      setPreview: (enabled: boolean) => { session.previewEnabled = enabled; },
      load: (project: unknown) => this.loadProject(projectFromJson(project)),
      state: () => {
        const now = performance.now();
        return { draftReady: Boolean(session.draft?.program && !session.preparing), draftBpm: session.draft?.project.bpm,
          error: session.draft?.error?.message, takes: session.live?.project.bpm, pending: Boolean(session.pending),
          clips: session.media.times(), time: session.transport.at(now), previewTime: session.transport.preview(now) };
      },
    } });
  }

  private requestTake() {
    if (this.updateTimer !== undefined) return;
    this.note = "";
    this.runtime?.take();
    this.updateStatus();
  }

  private edit(project: Project, redraw = true) {
    if (project === this.project) return;
    this.previous.push(this.project);
    if (this.previous.length > 80) this.previous.shift();
    this.next = [];
    this.applyProject(project, redraw);
  }

  private applyProject(project: Project, redraw: boolean) {
    this.project = project;
    this.note = "";
    this.bpm.value = String(project.bpm);
    if (redraw) { this.renderGraph(); this.refreshDialog(); }
    else this.updateBriefs();
    this.queueUpdate();
  }

  private restoreHistory(redo: boolean) {
    const from = redo ? this.next : this.previous;
    const to = redo ? this.previous : this.next;
    const project = from.pop();
    if (!project) return;
    to.push(this.project);
    this.selectedEdge = this.pending = undefined;
    if (this.selection && !project.nodes.some(item => item.id === this.selection)) this.viewer = this.selection = undefined;
    this.applyProject(project, true);
  }

  private loadProject(project: Project) {
    this.viewer = this.selection = this.pending = undefined;
    this.selectedEdge = undefined;
    this.bpm.value = String(project.bpm);
    this.edit(project);
    this.renderVideoAssets();
    this.fit();
  }

  private queueUpdate() {
    clearTimeout(this.updateTimer);
    const runtime = this.runtime;
    if (runtime) {
      this.updateTimer = window.setTimeout(() => {
        this.updateTimer = undefined;
        void runtime.update(this.project, this.viewer);
      }, 55);
    }
    this.updateStatus();
  }

  private report(text: string, error = false) {
    this.note = text;
    this.noteError = error;
    this.updateStatus();
  }

  private updateStatus() {
    el<HTMLButtonElement>("projection").disabled = !this.runtime;
    el<HTMLButtonElement>("undo").disabled = !this.previous.length;
    el<HTMLButtonElement>("redo").disabled = !this.next.length;
    const runtime = this.runtime;
    const draft = runtime?.draft;
    const busy = this.updateTimer !== undefined || runtime?.preparing;
    const error = this.unavailable || this.noteError && this.note || runtime?.message || !busy && draft?.error?.message;
    const waiting = runtime?.pending;
    const current = runtime?.live;
    this.take.disabled = Boolean(busy || !draft?.program || waiting);
    const status = el("status");
    status.textContent = error || this.note || (waiting ? "Take queued · waiting for the next ready frame" :
      busy || !runtime ? "Preparing Preview…" : current?.project === draft?.project ? "Live" : "Preview ready for Take");
    status.dataset.error = String(Boolean(error));
    const messages = new Map<string, string>();
    for (const issue of [draft?.error, draft?.viewerError]) if (issue instanceof GraphError && issue.nodeId) messages.set(issue.nodeId, issue.message);
    for (const [id, card] of this.cardsById) {
      const message = messages.get(id);
      card.dataset.error = String(Boolean(message));
      card.title = message ?? "";
    }
    for (const [id, card] of this.cardsById) {
      const details = card.querySelector(".node-error");
      if (details) details.textContent = messages.get(id) ?? "";
    }
    const issue = document.getElementById("dialog-error");
    if (issue) issue.textContent = messages.get(this.editorDialog.dataset.node ?? "") ?? "";
  }

  private async importFiles(files: File[], at?: Point, expected?: "video" | "texture") {
    const accepted = files.flatMap(file => {
      const kind: "texture" | "video" | undefined = isTextureAsset({ id: "", name: file.name, file }) ? "texture" :
        file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv|avi|ogv)$/i.test(file.name) ? "video" : undefined;
      return kind && (!expected || kind === expected) ? [{ file, kind }] : [];
    });
    if (!accepted.length) { this.report("Choose a supported video or image file.", true); return; }
    try {
      const imported = [];
      for (const { file, kind } of accepted) {
        const asset = await this.storage.add(file);
        imported.push({ asset, kind });
        this.registerAsset(asset);
      }
      if (imported.some(item => item.kind === "texture")) el<HTMLSelectElement>("texture-pack").value = "local";
      this.renderAssets();
      if (at) {
        imported.forEach(({ asset, kind }, index) => this.add(kind, { x: at.x, y: at.y + index * 130 }, { asset: asset.id }));
      } else this.refreshAssetPickers();
      this.report(`${imported.length} asset${imported.length === 1 ? "" : "s"} imported.`);
    } catch (error) { this.report(`Import failed: ${String(error)}`, true); }
  }

  private registerAsset(asset: Asset) {
    this.assets.set(asset.id, asset);
    this.runtime?.media.assets.set(asset.id, asset);
  }

  private async loadVideoExamples() {
    const status = el("video-catalog-status");
    status.hidden = false;
    status.textContent = "Loading PicoDevil examples…";
    try {
      const assets = await loadPicoDevilExamples();
      for (const asset of assets) this.registerAsset(asset);
      this.renderAssets();
      this.refreshAssetPickers();
      status.hidden = true;
    } catch {
      status.replaceChildren(make("span", "PicoDevil examples are unavailable."), button("Retry", () => void this.loadVideoExamples(), "quiet"));
    }
  }

  private async addVideoUrl() {
    const input = el<HTMLInputElement>("video-url");
    const addButton = el<HTMLButtonElement>("add-video-url");
    if (addButton.disabled) return;
    addButton.disabled = true;
    this.report("Adding media URL…");
    try {
      const asset = await importMediaUrl(input.value);
      const existing = this.assets.get(asset.id);
      if (existing && "url" in existing && existing.url === asset.url) {
        this.report(`${existing.name} is already in Videos.`);
      } else {
        await this.storage.remember(asset);
        this.registerAsset(asset);
        this.renderAssets();
        this.refreshAssetPickers();
        this.report(`${asset.name} added to Videos.`);
      }
      input.value = "";
    } catch (error) {
      this.report(error instanceof Error ? error.message : String(error), true);
    } finally {
      addButton.disabled = false;
    }
  }

  private async toggleCapture(kind: CaptureKind) {
    const runtime = this.runtime;
    if (!runtime || this.capturePending.has(kind)) return;
    const source = captureSources[kind];
    if (runtime.media.captureActive(source.id)) {
      runtime.media.stopCapture(kind);
      this.report(`${source.name} stopped.`);
      return;
    }
    this.capturePending.add(kind);
    this.updateCaptureControls();
    try {
      await runtime.media.startCapture(kind);
      if (runtime.media.captureActive(source.id)) {
        runtime.message = "";
        this.report(`${source.name} ready in Videos.`);
      }
    } catch (error) {
      this.report(`${source.name}: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      this.capturePending.delete(kind);
      this.updateCaptureControls();
    }
  }

  private updateCaptureControls() {
    for (const kind of captureKinds) {
      const { id, name } = captureSources[kind];
      const control = el<HTMLButtonElement>(kind);
      const active = this.runtime?.media.captureActive(id) ?? false;
      control.textContent = active ? `Stop ${name}` : name;
      control.setAttribute("aria-pressed", String(active));
      control.disabled = this.capturePending.has(kind);
    }
    this.renderVideoAssets();
  }

  private dropTarget(element: HTMLElement, onDrop: (event: DragEvent) => void | Promise<void>) {
    element.ondragover = event => {
      if (!event.dataTransfer?.types.some(type => type === "Files" || type === nodeDrag)) return;
      event.preventDefault();
      element.dataset.drop = "true";
      if (element === this.graph && event.dataTransfer.types.includes(nodeDrag)) this.setInsertion(this.edgeAt(event));
    };
    element.ondragleave = event => {
      if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) {
        element.dataset.drop = "false";
        if (element === this.graph) this.setInsertion(undefined);
      }
    };
    element.ondrop = event => {
      event.preventDefault();
      element.dataset.drop = "false";
      if (element === this.graph) this.setInsertion(undefined);
      if (event.dataTransfer) void onDrop(event);
    };
  }

  private assetOptions(kind: "video" | "texture") {
    const local = [...this.assets.values()].filter(asset => isTextureAsset(asset) === (kind === "texture"));
    return kind === "video" ? [...Object.entries(demo).map(([id, asset]) => [id, asset.name] as const), ...local.map(asset => [asset.id, asset.name] as const),
      ...captureKinds.map(kind => [captureSources[kind].id, captureSources[kind].name] as const)]
      : [...local, ...textures.values()].map(asset => [asset.id, asset.name] as const);
  }

  private fillAssetPicker(picker: HTMLSelectElement, kind: "video" | "texture", value: string) {
    const options = this.assetOptions(kind);
    picker.replaceChildren(...options.map(([id, name]) => new Option(name, id)));
    if (!options.some(([id]) => id === value)) picker.add(new Option("Missing media", value));
    picker.value = value;
  }

  private refreshAssetPickers() {
    for (const picker of this.cards.querySelectorAll<HTMLSelectElement>("[data-asset-kind]")) {
      this.fillAssetPicker(picker, picker.dataset.assetKind === "texture" ? "texture" : "video", picker.value);
    }
  }

  private attachDrag(element: HTMLElement, drop: Drop) {
    element.draggable = true;
    element.ondragstart = event => {
      if (!event.dataTransfer) return;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(nodeDrag, JSON.stringify(drop));
    };
  }

  private chooseLibrary(drop: Drop) {
    this.add(drop.kind, this.center(), drop.params, this.attachmentForSelection());
  }

  private textureUrl(id: string) {
    if (textures.has(id)) return import.meta.env.BASE_URL + id;
    const asset = this.assets.get(id);
    if (!asset) return "";
    if ("url" in asset) return asset.url;
    if (!this.imageUrls.has(id)) this.imageUrls.set(id, URL.createObjectURL(asset.file));
    return this.imageUrls.get(id)!;
  }

  private renderVideoAssets() {
    const makeRow = (entry: VideoEntry) => {
      const drop: Drop = { kind: entry.kind, params: { asset: entry.id } };
      const item = button("", () => this.chooseLibrary(drop), "asset");
      if (entry.thumbnail) {
        const thumb = make("img", "", "video-thumbnail");
        thumb.alt = "";
        thumb.loading = "lazy";
        thumb.draggable = false;
        thumb.src = entry.thumbnail;
        item.append(thumb);
      }
      item.append(make("span", entry.name, "asset-name"), make("small", entry.status ?? (entry.kind === "video" ? "Video" : "Image")));
      this.attachDrag(item, drop);
      return item;
    };
    const clips: VideoEntry[] = Object.entries(demo).map(([id, asset]) => ({ id, name: asset.name, kind: "video" }));
    for (const kind of captureKinds) {
      const { id, name } = captureSources[kind];
      const active = this.runtime?.media.captureActive(id);
      if (active || this.project.nodes.some(node => node.params.asset === id)) {
        clips.unshift({ id, name, kind: "video", status: active ? "Live" : "Stopped" });
      }
    }
    const examples: VideoEntry[] = [];
    for (const asset of this.assets.values()) {
      if ("file" in asset && isTextureAsset(asset)) continue;
      const row: VideoEntry = { id: asset.id, name: asset.name, kind: isTextureAsset(asset) ? "texture" : "video",
        thumbnail: "url" in asset ? asset.thumbnail : undefined };
      ("url" in asset && asset.example ? examples : clips).push(row);
    }
    const list = el("assets");
    list.replaceChildren(...clips.map(makeRow));
    if (examples.length) {
      const heading = make("h3", "PicoDevil Examples", "video-examples-heading");
      list.append(heading, ...examples.map(makeRow));
    }
  }

  private renderAssets() {
    this.renderVideoAssets();
    const selected = el<HTMLSelectElement>("texture-pack").value;
    const items = selected === "local" ? [...this.assets.values()].filter(isTextureAsset)
      : texturePacks.find(pack => pack.id === selected)?.assets ?? [];
    el("texture-assets").replaceChildren(...items.map(asset => {
      const drop: Drop = { kind: "texture", params: { asset: asset.id } };
      const item = button("", () => this.chooseLibrary(drop), "texture-tile");
      const thumb = make("img");
      thumb.src = this.textureUrl(asset.id);
      thumb.alt = "";
      thumb.loading = "lazy";
      thumb.draggable = false;
      item.append(thumb, make("span", asset.name));
      this.attachDrag(item, drop);
      return item;
    }));
    if (!items.length) el("texture-assets").append(make("p", "Import an image to add a local texture."));
  }

  private configureLibrary() {
    el<HTMLFormElement>("video-url-form").onsubmit = event => {
      event.preventDefault();
      void this.addVideoUrl();
    };
    for (const kind of captureKinds) el(kind).onclick = () => { void this.toggleCapture(kind); };
    for (const tab of tabNames) {
      const item = el<HTMLButtonElement>(`tab-${tab}`);
      item.onclick = () => this.showTab(tab);
      item.onkeydown = event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = tabNames[(tabNames.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabNames.length - 1)) % tabNames.length];
        this.showTab(next);
        el(`tab-${next}`).focus();
      };
    }
    const texturePack = el<HTMLSelectElement>("texture-pack");
    for (const pack of texturePacks) texturePack.add(new Option(pack.label, pack.id));
    texturePack.add(new Option("My textures", "local"));
    texturePack.onchange = () => this.renderAssets();
    const microphone = el<HTMLButtonElement>("microphone");
    const syncAudio = () => {
      const active = this.runtime?.audio.active ?? false;
      microphone.textContent = active ? "Disable microphone" : "Enable microphone";
      microphone.setAttribute("aria-pressed", String(active));
    };
    microphone.onclick = async () => {
      const audio = this.runtime?.audio;
      if (!audio) return;
      microphone.disabled = true;
      try {
        if (audio.active) audio.stop();
        else await audio.start(syncAudio);
      } catch (error) { this.report(`Microphone unavailable: ${String(error)}`, true); }
      finally { microphone.disabled = false; syncAudio(); }
    };
    syncAudio();
    el("audio-signals").replaceChildren(...audioBands.map((band, index) => {
      const drop: Drop = { kind: "audio", params: { band } };
      const item = button("", () => this.chooseLibrary(drop), "asset");
      const level = make("span", "", "audio-level");
      level.dataset.audioBand = String(index);
      level.setAttribute("aria-hidden", "true");
      item.append(make("span", band), level);
      this.attachDrag(item, drop);
      return item;
    }));
    this.revealReference = setupReference(el("reference"), drop => this.chooseLibrary(drop), (element, drop) => this.attachDrag(element, drop));
  }

  private showTab(tab: Tab) {
    for (const name of tabNames) {
      const button = el<HTMLButtonElement>(`tab-${name}`);
      button.setAttribute("aria-selected", String(name === tab));
      button.tabIndex = name === tab ? 0 : -1;
      el(tabs[name]).hidden = name !== tab;
    }
  }

  private showReference(kind: Kind) {
    this.showTab("reference");
    this.revealReference?.(kind);
  }

  private updateBriefs() {
    for (const item of this.project.nodes) {
      const card = this.cardsById.get(item.id);
      const code = card?.querySelector(".code-preview");
      if (code) code.textContent = String(item.params.code);
      const strip = card?.querySelector<HTMLElement>(".step-strip");
      if (strip) {
        const steps = String(item.params.grid).split(",").map(Number);
        if (strip.children.length !== steps.length) strip.replaceChildren(...steps.map(() => make("span")));
        steps.forEach((value, index) => (strip.children[index] as HTMLElement).style.setProperty("--level", String(Math.min(1, Math.max(0, value)))));
      }
      const ramp = card?.querySelector<HTMLElement>(".ramp-preview");
      if (ramp) {
        const low = item.params["input:low"] ?? nodes.ramp.inputs.low.value;
        const high = item.params["input:high"] ?? nodes.ramp.inputs.high.value;
        const connected = this.project.edges.some(edge => edge.to === item.id && (edge.input === "low" || edge.input === "high"));
        if (isColorValue(low) && isColorValue(high) && !connected) {
          const from = Number(item.params.from) * 100, to = Number(item.params.to) * 100;
          const start = `${colorCss(low)} ${from}%`, end = `${colorCss(high)} ${to}%`;
          ramp.style.background = from === to ? colorCss(low) : `linear-gradient(90deg, ${from < to ? `${start}, ${end}` : `${end}, ${start}`})`;
          ramp.hidden = false;
        } else ramp.hidden = true;
      }
      const waveform = card?.querySelector<HTMLCanvasElement>(".lfo-preview");
      if (waveform) this.waveform(waveform, String(item.params.shape));
    }
  }

  private waveform(canvas: HTMLCanvasElement, shape: string) {
    if (canvas.dataset.shape === shape) return;
    canvas.dataset.shape = shape;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue("--kind").trim();
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= canvas.width; x++) {
      const t = x / canvas.width;
      const value = shape === "Saw" ? t : shape === "Triangle" ? 1 - Math.abs(2 * t - 1) : 0.5 + 0.5 * Math.sin(t * 2 * Math.PI);
      const y = 3 + (1 - value) * (canvas.height - 6);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private animateControls(beats: number, audio: readonly number[]) {
    for (const item of this.project.nodes) {
      const card = this.cardsById.get(item.id);
      if (!card) continue;
      if (item.kind === "steps") {
        const strip = card.querySelector(".step-strip");
        const count = strip?.children.length ?? 0;
        if (strip && count) {
          const active = Math.floor(beats * Number(item.params.division)) % count;
          const cell = strip.children[active];
          if (cell?.getAttribute("data-active") === "true") continue;
          strip.querySelector("[data-active]")?.removeAttribute("data-active");
          cell?.setAttribute("data-active", "true");
        }
      }
    }
    if (!el("audio").hidden) for (const meter of el("audio-signals").querySelectorAll<HTMLElement>("[data-audio-band]")) {
      meter.style.setProperty("--level", String(audio[Number(meter.dataset.audioBand)]));
    }
  }

  private renderGraph() {
    this.cardsById.clear();
    this.outlets.clear();
    this.inlets.clear();
    const analyzed = analyze(this.project);
    this.cards.replaceChildren(...this.project.nodes.map(item => {
      const def = nodes[item.kind];
      const card = make("article", "", "node");
      card.dataset.group = def.group;
      card.dataset.node = item.id;
      card.dataset.kind = item.kind;
      card.style.left = `${item.x}px`;
      card.style.top = `${item.y}px`;
      this.cardsById.set(item.id, card);
      const header = make("header", "", "node-head");
      const title = make("span", def.label, "node-title");
      header.append(title);
      if (item.kind !== "junction") {
        const preview = button("◉", () => this.toggleMini(item.id), "node-tool");
        preview.setAttribute("aria-label", `Preview ${def.label}`);
        preview.setAttribute("aria-expanded", String(item.id === this.mini && item.id === this.viewer));
        preview.title = `Preview ${def.label}`;
        const help = button("?", () => this.showReference(item.kind), "node-tool");
        help.setAttribute("aria-label", `${def.label} reference`);
        help.title = "Open Reference";
        header.append(preview, help);
      }
      header.onpointerdown = event => { if (!(event.target as Element).closest("button")) this.startMove(event, item, card); };
      header.onclick = () => { if (this.selection !== item.id) this.select(item.id); };
      card.append(header);
      card.onpointerdown = event => {
        if (!(event.target as Element).closest("button, header, input, select, textarea, label") && this.selection !== item.id) this.select(item.id);
      };
      const signal = analyzed.signals.get(item.id)!;
      if (item.kind !== "output") {
        const port = make("div", "", "port out");
        port.dataset.type = signal.type;
        port.append(make("span", typeNames[signal.type]), this.socket({ node: item.id }, `${def.label} ${typeNames[signal.type]} output`,
          this.project.edges.some(edge => edge.from === item.id) ? "Alt-click to disconnect" : undefined));
        card.append(port);
      }
      for (const [key, input] of Object.entries(def.inputs)) {
        const port = make("div", "", "port");
        const type = item.kind === "junction" ? signal.type : input.type;
        port.dataset.type = type;
        const edgeKey = inputKey(item.id, key);
        const hint = [typeNames[type], analyzed.conversions.get(edgeKey), analyzed.incoming.has(edgeKey) && "Alt-click to disconnect"].filter(Boolean).join("\n");
        port.append(this.socket({ node: item.id, input: key }, `${def.label} ${input.label} input`, hint));
        const value = item.params["input:" + key] ?? input.value;
        if (item.kind !== "junction" && value !== undefined && !analyzed.incoming.has(edgeKey)) {
          const set = (next: Value) => this.changeParam(item.id, "input:" + key, next);
          if (isColorValue(value)) port.append(this.colorControl(input.label, value, set));
          else {
            const integer = input.type === "integer";
            port.append(this.field(input.label, this.control(value, set, 0.01, undefined, undefined, integer)));
          }
        } else port.append(make("span", input.label));
        card.append(port);
      }
      if (item.kind !== "junction") {
        const footer = make("div", "", "node-fields");
        this.parameterFields(item, footer);
        if (item.kind === "ramp") footer.prepend(make("div", "", "ramp-preview"));
        if (item.kind === "lfo") {
          const waveform = make("canvas", "", "lfo-preview");
          waveform.width = 180;
          waveform.height = 32;
          waveform.setAttribute("aria-label", "Oscillator waveform");
          footer.prepend(waveform);
        }
        if (item.kind === "steps" || item.kind === "expression") {
          footer.append(item.kind === "steps" ? make("div", "", "step-strip") : make("code", String(item.params.code), "code-preview"));
          const edit = button(item.kind === "steps" ? "Edit Steps…" : "Edit WGSL…", () => this.openNodeDialog(item.id), "node-edit");
          edit.setAttribute("aria-haspopup", "dialog");
          footer.append(edit);
        }
        if (footer.childElementCount) card.append(footer);
        if (item.id === this.mini && item.id === this.viewer) {
          const canvas = make("canvas", "", "node-mini");
          canvas.width = 192;
          canvas.height = 108;
          canvas.setAttribute("aria-label", `${def.label} mini preview`);
          card.append(canvas);
        }
      }
      const error = make("p", "", "error node-error");
      error.setAttribute("role", "alert");
      card.append(error);
      return card;
    }));
    this.updateBriefs();
    this.renderSelection();
    this.renderWires();
    this.syncMini();
    this.updateStatus();
  }

  private select(id?: string) {
    if (id === this.selection && id === this.viewer && !this.selectedEdge) return;
    const hasMini = Boolean(this.mini && (this.viewer === this.mini) !== (id === this.mini));
    this.selectedEdge = undefined;
    this.selection = this.viewer = id;
    if (hasMini) this.renderGraph();
    else this.renderSelection();
    this.queueUpdate();
  }

  private renderSelection() {
    for (const [id, card] of this.cardsById) card.dataset.selected = String(id === this.selection);
    const target = this.project.nodes.find(item => item.id === this.viewer);
    el("preview-label").textContent = target ? nodes[target.kind].label : "Output";
  }

  private changeParam(id: string, key: string, value: Value) {
    if (this.project.nodes.find(node => node.id === id)?.params[key] === value) return;
    this.edit({ ...this.project, nodes: this.project.nodes.map(item =>
      item.id === id ? { ...item, params: { ...item.params, [key]: value } } : item) }, false);
  }

  private changeNumberType(item: GraphNode, type: string) {
    const value = Number(item.params.value);
    const params = { ...item.params, type, value: type === "Integer" ? roundInteger(value) : value };
    const project = { ...this.project, nodes: this.project.nodes.map(node => node.id === item.id ? { ...node, params } : node) };
    this.edit(withJunctionTypes(project));
    this.cardsById.get(item.id)?.querySelector<HTMLSelectElement>("select")?.focus();
  }

  private socket(port: Port, label: string, hint?: string) {
    const socket = button("", () => {});
    socket.dataset.port = port.node;
    socket.dataset.input = port.input ?? "";
    if (port.input) socket.dataset.to = port.node;
    socket.setAttribute("aria-label", label);
    socket.title = hint || label;
    socket.onpointerdown = event => this.startCable(event, port);
    socket.onclick = event => { if (event.detail === 0) this.choosePort(port); };
    socket.oncontextmenu = event => { event.preventDefault(); this.disconnectPort(port); };
    if (port.input) this.inlets.set(inputKey(port.node, port.input), socket);
    else this.outlets.set(port.node, socket);
    return socket;
  }

  private parameterFields(item: GraphNode, root: HTMLElement) {
    const def = nodes[item.kind];
    for (const [key, param] of Object.entries(def.parameters)) {
      if (key === "grid" || key === "code") continue;
      const value = item.params[key];
      if (param.options || key === "asset") {
        const select = make("select");
        if (key === "asset") {
          const kind = item.kind === "texture" ? "texture" : "video";
          select.dataset.assetKind = kind;
          this.fillAssetPicker(select, kind, String(value));
        } else {
          for (const option of param.options ?? []) select.add(new Option(option, option));
          select.value = String(value);
        }
        select.onchange = () => {
          if (item.kind === "value" && key === "type") {
            this.changeNumberType(this.project.nodes.find(node => node.id === item.id)!, select.value);
          } else this.changeParam(item.id, key, select.value);
        };
        root.append(this.field(param.label, select));
      } else {
        const integer = item.kind === "value" && item.params.type === "Integer";
        if (typeof value !== "object") {
          root.append(this.field(param.label, this.control(value, next => this.changeParam(item.id, key, next), param.step, param.min, param.max, integer)));
        }
      }
    }
  }

  private toggleMini(id: string) {
    this.mini = this.mini === id && this.viewer === id ? undefined : id;
    this.viewer = this.selection = id;
    this.renderGraph();
    this.queueUpdate();
  }

  private syncMini() {
    this.runtime?.setMini(this.viewer ? this.cardsById.get(this.viewer)?.querySelector<HTMLCanvasElement>(".node-mini") ?? undefined : undefined);
  }

  private openNodeDialog(id: string) {
    this.select(id);
    if (this.project.nodes.find(node => node.id === id)?.kind === "expression" && this.mini !== id) this.toggleMini(id);
    this.editorDialog.dataset.node = id;
    this.refreshDialog();
    if (!this.editorDialog.open) this.editorDialog.showModal();
  }

  private refreshDialog() {
    const id = this.editorDialog.dataset.node;
    const item = this.project.nodes.find(node => node.id === id);
    if (!item || item.kind !== "steps" && item.kind !== "expression") {
      if (this.editorDialog.open) this.editorDialog.close();
      return;
    }
    if (!this.editorDialog.open && id !== this.selection) return;
    el("node-editor-title").textContent = nodes[item.kind].label;
    const root = el("node-editor-fields");
    root.replaceChildren();
    if (item.kind === "steps") this.stepEditor(item, root);
    else {
      const area = make("textarea");
      area.value = String(item.params.code);
      area.spellcheck = false;
      area.oninput = () => this.changeParam(item.id, "code", area.value);
      root.append(this.field("WGSL expression", area), make("p", "Returns a Float. Inputs: a, b, uv, time.", "expression-help"));
      const issue = make("p", "", "error");
      issue.id = "dialog-error";
      issue.setAttribute("role", "alert");
      root.append(issue);
    }
  }

  private stepEditor(item: GraphNode, root: HTMLElement) {
    const grid = make("div", "", "step-grid");
    const values = String(item.params.grid).split(",").map(Number);
    for (const [index, value] of values.entries()) {
      const step = make("div", "", "step");
      const slider = make("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.01";
      slider.value = String(value);
      slider.setAttribute("aria-label", `Step ${index + 1} slider`);
      const commit = (next: number) => {
        values[index] = next;
        this.changeParam(item.id, "grid", values.join(","));
      };
      const numeric = this.control(value, next => {
        slider.value = String(next);
        commit(Number(next));
      }, 0.01, 0, 1);
      numeric.setAttribute("aria-label", `Step ${index + 1} value`);
      slider.oninput = () => { numeric.value = slider.value; commit(slider.valueAsNumber); };
      step.append(make("span", `Step ${index + 1}`), slider, numeric);
      grid.append(step);
    }
    root.append(grid);
    const resize = (add: boolean) => {
      this.changeParam(item.id, "grid", (add ? [...values, 0] : values.slice(0, -1)).join(","));
      this.refreshDialog();
    };
    const fewer = button("Remove Last Step", () => resize(false), "quiet");
    fewer.disabled = values.length <= 1;
    const more = button("Add Step", () => resize(true));
    more.disabled = values.length >= 16;
    root.append(fewer, more);
  }

  private field(label: string, control: HTMLElement) {
    const field = make("label", "", "field");
    field.append(make("span", label), control);
    return field;
  }

  private colorControl(label: string, value: ColorValue, set: (next: ColorValue) => void) {
    const row = make("div", "", "field color-control");
    const channels = make("div", "", "color-channels");
    let color = value;
    const update = (next: ColorValue) => { color = next; set(next); };
    const rgb = make("input");
    rgb.type = "color";
    rgb.value = value.hex;
    rgb.setAttribute("aria-label", label);
    rgb.oninput = () => update({ ...color, hex: rgb.value });
    const alpha = this.control(value.alpha, next => update({ ...color, alpha: Number(next) }), 0.01, 0, 1);
    alpha.setAttribute("aria-label", `${label} Alpha`);
    alpha.title = "Alpha (0–1)";
    channels.append(rgb, alpha);
    row.append(make("span", label), channels);
    return row;
  }

  private control(value: number | string | boolean, set: (next: Value) => void, step?: number, min?: number, max?: number, integer = false) {
    const input = make("input");
    input.type = typeof value === "number" ? "number" : typeof value === "boolean" ? "checkbox" : "text";
    input.value = String(value);
    input.checked = value === true;
    if (integer) { step = 1; min = integerMin; max = integerMax; }
    if (step !== undefined) input.step = String(step);
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    let lastValue = value;
    const commit = (next: Value) => {
      if (typeof next !== "object") lastValue = next;
      set(next);
    };
    if (input.type === "number") bindNumberDrag(input, step, commit);
    input.oninput = () => {
      if (input.type === "number" && (!Number.isFinite(input.valueAsNumber) ||
          input.validity.rangeUnderflow || input.validity.rangeOverflow || (integer && !Number.isInteger(input.valueAsNumber)))) return;
      commit(input.type === "number" ? input.valueAsNumber : input.type === "checkbox" ? input.checked : input.value);
    };
    if (integer) input.onblur = () => { input.value = String(lastValue); };
    return input;
  }

  private add(kind: Kind, point: Point, params: Record<string, Value> = {}, attach?: Attach, required = false) {
    if (attach && kind !== "junction") point = this.clearPoint(point, kind);
    const node = makeNode(kind, Math.round(point.x), Math.round(point.y), undefined, params);
    const board = { ...this.project, nodes: [...this.project.nodes, node] };
    const attached = attach?.(board, node);
    if (required && !attached) return false;
    this.selectedEdge = undefined;
    this.viewer = this.selection = node.id;
    this.edit(attached ?? board);
    this.reveal(node.id);
    this.graph.focus({ preventScroll: true });
    return true;
  }

  private clearPoint(point: Point, kind: Kind) {
    const def = nodes[kind];
    const estimatedHeight = 65 + Object.keys(def.inputs).length * 27 + Object.keys(def.parameters).length * 28;
    let y = point.y;
    const neighbors = this.project.nodes.filter(node => node.x + (this.cardsById.get(node.id)?.offsetWidth ?? 196) + 12 > point.x &&
      node.x < point.x + 208).sort((a, b) => a.y - b.y);
    for (const neighbor of neighbors) {
      const bottom = neighbor.y + (this.cardsById.get(neighbor.id)?.offsetHeight ?? 100) + 12;
      if (y < bottom && y + estimatedHeight + 12 > neighbor.y) y = bottom;
    }
    return { x: point.x, y };
  }

  private reveal(id: string) {
    const card = this.cardsById.get(id)?.getBoundingClientRect();
    if (!card) return;
    const viewport = this.graph.getBoundingClientRect();
    const margin = 14;
    const dx = card.right > viewport.right - margin ? viewport.right - margin - card.right : Math.max(0, viewport.left + margin - card.left);
    const dy = card.bottom > viewport.bottom - margin ? viewport.bottom - margin - card.bottom : Math.max(0, viewport.top + margin - card.top);
    if (dx || dy) {
      this.pan = { x: this.pan.x + dx, y: this.pan.y + dy };
      this.updateCamera();
    }
  }

  private attachmentForSelection(): Attach | undefined {
    const active = this.project.nodes.find(node => node.id === this.selection);
    if (this.selectedEdge) {
      const edge = this.selectedEdge;
      return (project, node) => insertNode(project, node, edge);
    }
    if (!active) return;
    if (active.kind === "output") {
      const edge = this.project.edges.find(edge => edge.to === active.id);
      return (project, node) => edge ? insertNode(project, node, edge) : attachNode(project, node, { node: active.id, input: "image" });
    }
    const outgoing = this.project.edges.filter(edge => edge.from === active.id);
    return (project, node) => (outgoing.length === 1 ? insertNode(project, node, outgoing[0]) : undefined) ??
      attachNode(project, node, { node: active.id });
  }

  private dropNode(drop: Drop, event: DragEvent) {
    const menu = this.menuContext;
    if (menu) this.closeMenu(true, false);
    const point = this.inScene(event);
    const edge = this.edgeAt(event);
    if (edge) this.add(drop.kind, { x: point.x - 85, y: point.y - 24 }, drop.params, (board, node) => insertNode(board, node, edge), true);
    else {
      const port = this.portAt(event);
      const occupied = port?.input && this.project.edges.find(edge => edge.to === port.node && edge.input === port.input);
      if (port) {
        const owner = this.project.nodes.find(item => item.id === port.node)!;
        this.add(drop.kind, { x: owner.x + (port.input ? -232 : 232), y: point.y - 25 }, drop.params,
          (board, node) => occupied ? insertNode(board, node, occupied) : attachNode(board, node, port), true);
      } else this.add(drop.kind, point, drop.params, menu?.attach, menu?.required);
    }
  }

  private removeSelection() {
    const id = this.selection;
    if (!id) return;
    this.selection = this.viewer = undefined;
    this.edit({ ...this.project, nodes: this.project.nodes.filter(node => node.id !== id),
      edges: this.project.edges.filter(edge => edge.from !== id && edge.to !== id) });
  }

  private startMove(event: PointerEvent, item: GraphNode, card: HTMLElement) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.graph.focus({ preventScroll: true });
    this.select(item.id);
    card = this.cardsById.get(item.id) ?? card;
    const start = this.inScene(event);
    let x = item.x, y = item.y;
    let moved = false;
    trackPointerDrag(event, next => {
      if (!moved && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 4) return;
      moved = true;
      const pos = this.inScene(next);
      x = Math.round(item.x + pos.x - start.x);
      y = Math.round(item.y + pos.y - start.y);
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      this.renderWires();
      const rect = card.getBoundingClientRect();
      const middle = rect.top + Math.min(rect.height * 0.5, 60 * this.zoom);
      const edge = [next, { clientX: rect.left, clientY: middle }, { clientX: rect.left + rect.width / 2, clientY: middle },
        { clientX: rect.right, clientY: middle }].map(point => this.edgeAt(point))
        .find(edge => edge && insertNode(this.project, item, edge));
      this.setInsertion(edge);
    }, end => {
      const edge = this.insertion;
      this.setInsertion(undefined);
      if (!moved) return;
      if (!end) { this.renderGraph(); return; }
      const node = { ...item, x, y };
      const board = { ...this.project, nodes: this.project.nodes.map(current => current.id === item.id ? node : current) };
      this.edit(edge ? insertNode(board, node, edge) ?? board : board);
    });
  }

  private startPan(event: PointerEvent) {
    if (event.button !== 0 && event.button !== 1 || (event.target as Element).closest(".node, .node-menu, .wire-hit")) return;
    this.graph.focus({ preventScroll: true });
    this.setPending();
    const { x, y } = this.pan;
    const start = { x: event.clientX, y: event.clientY };
    this.drag(event, move => {
      this.pan = { x: x + move.clientX - start.x, y: y + move.clientY - start.y };
      this.updateCamera();
    }, () => this.renderWires());
  }

  private drag(event: PointerEvent, move: (event: PointerEvent) => void, end: () => void) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const motion = (next: PointerEvent) => { if (next.pointerId === event.pointerId) move(next); };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      target.removeEventListener("pointermove", motion);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      end();
    };
    target.addEventListener("pointermove", motion);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  private startCable(event: PointerEvent, port: Port) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.altKey) { this.disconnectPort(port); return; }
    this.graph.focus({ preventScroll: true });
    const detached = port.input ? this.project.edges.find(edge => edge.to === port.node && edge.input === port.input) : undefined;
    const origin = detached ? { node: detached.from } : port;
    const base = this.project;
    let moved = false;
    trackPointerDrag(event, next => {
      if (!moved && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 5) return;
      this.lastPoint = this.inScene(next);
      if (!moved) { moved = true; this.setPending(origin, detached); }
      else this.renderWires();
    }, end => {
      if (!end || base !== this.project) { this.setPending(); return; }
      if (!moved) { this.lastPoint = this.inScene(end); this.choosePort(port); return; }
      const target = this.portAt(end, this.compatibleSockets);
      if (target) { this.choosePort(target); return; }
      const under = document.elementFromPoint(end.clientX, end.clientY);
      const blank = under && this.graph.contains(under) && !under.closest(".node, .wire-hit, .node-menu");
      this.setPending();
      if (blank) this.openMenu({ x: end.clientX, y: end.clientY }, detached, detached ? undefined : origin, Boolean(detached));
    });
  }

  private setPending(port?: Port, detached?: Edge) {
    this.pending = port;
    this.detached = detached;
    this.compatibleSockets.clear();
    const candidates = port?.input ? this.outlets.values() : this.inlets.values();
    const project = detached ? { ...this.project, edges: this.project.edges.filter(edge => edge !== detached) } : this.project;
    for (const socket of [...this.outlets.values(), ...this.inlets.values()]) socket.classList.remove("compatible");
    if (port) for (const socket of candidates) {
      if (connectPorts(project, port, this.portFrom(socket)!)) {
        this.compatibleSockets.add(socket);
        socket.classList.add("compatible");
      }
    }
    this.renderWires();
  }

  private choosePort(port: Port) {
    if (!this.pending || Boolean(this.pending.input) === Boolean(port.input)) { this.setPending(port); return; }
    const base = this.detached ? { ...this.project, edges: this.project.edges.filter(edge => edge !== this.detached) } : this.project;
    const next = connectPorts(base, this.pending, port);
    this.setPending();
    if (next) this.edit(next);
    else this.report("These sockets cannot be connected.", true);
  }

  private portFrom(element: Element | null): Port | undefined {
    const socket = element?.closest<HTMLButtonElement>("button[data-port]");
    if (socket && this.graph.contains(socket)) return { node: socket.dataset.port!, input: socket.dataset.input || undefined };
  }

  private portAt(point: { clientX: number; clientY: number }, nearby?: Set<HTMLElement>): Port | undefined {
    const under = document.elementFromPoint(point.clientX, point.clientY);
    const direct = this.portFrom(under);
    if (direct || !nearby || !this.graph.contains(under)) return direct;
    let nearest: HTMLElement | undefined;
    let distance = 15;
    for (const socket of nearby) {
      const rect = socket.getBoundingClientRect();
      const d = Math.hypot(point.clientX - rect.left - rect.width / 2, point.clientY - rect.top - rect.height / 2);
      if (d < distance) { nearest = socket; distance = d; }
    }
    return this.portFrom(nearest ?? null);
  }

  private disconnectPort(port: Port) {
    if (port.input) { this.disconnect(port.node, port.input); return; }
    const edges = this.project.edges.filter(edge => edge.from !== port.node);
    if (edges.length !== this.project.edges.length) {
      this.setPending();
      this.selectedEdge = undefined;
      this.edit({ ...this.project, edges });
    }
  }

  private disconnect(to: string, input: string) {
    if (!this.project.edges.some(edge => edge.to === to && edge.input === input)) return;
    this.setPending();
    this.selectedEdge = undefined;
    this.edit({ ...this.project, edges: this.project.edges.filter(edge => edge.to !== to || edge.input !== input) });
  }

  private wire(a: Point, b: Point, css: string, type: SocketType = "float") {
    const curve = document.createElementNS(svg, "path");
    const bend = Math.max(44, Math.abs(b.x - a.x) * 0.5);
    curve.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`);
    curve.setAttribute("class", css);
    curve.dataset.type = type;
    return curve;
  }

  private edgeAt(point: { clientX: number; clientY: number }) {
    for (const element of document.elementsFromPoint(point.clientX, point.clientY)) {
      const edge = this.wireElements.get(element as SVGPathElement);
      if (edge) return edge;
    }
  }

  private setInsertion(edge?: Edge) {
    if (this.insertion === edge) return;
    this.insertion = edge;
    for (const [hit, link] of this.wireElements) hit.parentElement?.classList.toggle("wire-inserting", link === edge);
  }

  private renderWires() {
    const analyzed = analyze(this.project);
    this.wireElements.clear();
    this.wires.replaceChildren();
    const scene = this.scene.getBoundingClientRect();
    const socketPoint = (socket: HTMLButtonElement) => {
      const box = socket.getBoundingClientRect();
      return { x: (box.left + box.width / 2 - scene.left) / this.zoom, y: (box.top + box.height / 2 - scene.top) / this.zoom };
    };
    for (const edge of this.project.edges) {
      const from = this.outlets.get(edge.from), to = this.inlets.get(inputKey(edge.to, edge.input));
      if (!from || !to) continue;
      const group = document.createElementNS(svg, "g");
      group.classList.toggle("wire-selected", edge === this.selectedEdge);
      group.classList.toggle("wire-inserting", edge === this.insertion);
      group.classList.toggle("wire-detached", edge === this.detached);
      const title = document.createElementNS(svg, "title");
      title.textContent = (analyzed.conversions.get(inputKey(edge.to, edge.input)) ||
        `${nodes[analyzed.byId.get(edge.from)!.kind].label} → ${nodes[analyzed.byId.get(edge.to)!.kind].label}`) +
        "\nAlt-click to disconnect · Double-click to reroute";
      const fromPoint = socketPoint(from), toPoint = socketPoint(to);
      const hit = this.wire(fromPoint, toPoint, "wire-hit");
      this.wireElements.set(hit, edge);
      hit.onclick = event => {
        if (event.altKey) { this.disconnect(edge.to, edge.input); return; }
        this.graph.focus({ preventScroll: true });
        this.selectedEdge = edge;
        this.selection = undefined;
        this.renderSelection();
        for (const [path, other] of this.wireElements) path.parentElement?.classList.toggle("wire-selected", other === edge);
      };
      hit.ondblclick = event => {
        this.selectedEdge = undefined;
        const point = this.inScene(event);
        this.add("junction", { x: point.x - 26, y: point.y - 14 }, {}, (board, node) => insertNode(board, node, edge), true);
      };
      hit.oncontextmenu = event => {
        event.preventDefault();
        this.openMenu({ x: event.clientX, y: event.clientY }, edge);
      };
      group.append(title, this.wire(fromPoint, toPoint, "wire", analyzed.signals.get(edge.from)!.type), hit);
      this.wires.append(group);
    }
    for (const [id, socket] of this.outlets) socket.dataset.pending = String(id === this.pending?.node && !this.pending?.input);
    for (const [key, socket] of this.inlets) socket.dataset.pending = String(Boolean(this.pending?.input && key === inputKey(this.pending.node, this.pending.input)));
    if (this.pending && this.lastPoint) {
      const { node, input } = this.pending;
      const socket = input ? this.inlets.get(inputKey(node, input)) : this.outlets.get(node);
      if (socket) {
        const fixed = socketPoint(socket);
        const type = socket.parentElement?.dataset.type as SocketType | undefined;
        this.wires.append(input ? this.wire(this.lastPoint, fixed, "wire wire-pending", type) : this.wire(fixed, this.lastPoint, "wire wire-pending", type));
      }
    }
  }

  private inScene(point: { clientX: number; clientY: number }) {
    const box = this.scene.getBoundingClientRect();
    return { x: (point.clientX - box.left) / this.zoom, y: (point.clientY - box.top) / this.zoom };
  }

  private center() {
    const box = this.graph.getBoundingClientRect();
    return this.inScene({ clientX: box.left + box.width / 2 - 75, clientY: box.top + box.height / 2 - 40 });
  }

  private updateCamera() {
    this.scene.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    this.graph.style.backgroundPosition = `${this.pan.x}px ${this.pan.y}px`;
    const spacing = Math.max(10, 20 * this.zoom);
    this.graph.style.backgroundSize = `${spacing}px ${spacing}px`;
    el("zoom").textContent = `${Math.round(this.zoom * 100)}%`;
    this.renderWires();
  }

  private fit() {
    if (!this.project.nodes.length) { this.zoom = 1; this.pan = { x: 22, y: 22 }; this.updateCamera(); return; }
    const minX = Math.min(...this.project.nodes.map(node => node.x)), minY = Math.min(...this.project.nodes.map(node => node.y));
    const maxX = Math.max(...this.project.nodes.map(node => node.x + (this.cardsById.get(node.id)?.offsetWidth ?? 185)));
    const maxY = Math.max(...this.project.nodes.map(node => node.y + (this.cardsById.get(node.id)?.offsetHeight ?? 100)));
    this.zoom = Math.max(0.14, Math.min(1, (this.graph.clientWidth - 54) / (maxX - minX), (this.graph.clientHeight - 54) / (maxY - minY)));
    this.pan = { x: (this.graph.clientWidth - (maxX - minX) * this.zoom) / 2 - minX * this.zoom,
      y: (this.graph.clientHeight - (maxY - minY) * this.zoom) / 2 - minY * this.zoom };
    this.updateCamera();
  }

  private openMenu(client?: Point, edge?: Edge, port?: Port, detached = false) {
    if (this.menu.open) this.closeMenu(false, false);
    const rect = this.graph.getBoundingClientRect();
    const anchor = client ? { x: client.x - rect.left, y: client.y - rect.top } : { x: 32, y: 24 };
    let point = client ? this.inScene({ clientX: client.x, clientY: client.y }) : this.center();
    if (edge) point = { x: point.x - 85, y: point.y - 22 };
    if (port?.input) point = { x: point.x - 185, y: point.y };
    const active = this.project.nodes.find(node => node.id === this.selection);
    if (!edge && !port && active) {
      const nextY = this.project.nodes.filter(node => Math.abs(node.x - active.x - 235) < 195)
        .reduce((max, node) => Math.max(max, node.y + (this.cardsById.get(node.id)?.offsetHeight ?? 100) + 16), active.y);
      point = active.kind === "output" ? { x: active.x - 220, y: active.y + 105 } : { x: active.x + 235, y: nextY };
    }
    const explicit = edge ?? this.selectedEdge;
    const attach: Attach | undefined = explicit ? (board, node) => insertNode(board, node, explicit)
      : port ? (board, node) => attachNode(board, node, port) : this.attachmentForSelection();
    const required = Boolean(explicit || port);
    const compatible = kinds.filter(kind => {
      if (kind === "output" && this.project.nodes.some(node => node.kind === "output")) return false;
      if (!required || !attach) return true;
      const node = makeNode(kind, point.x, point.y);
      return Boolean(attach({ ...this.project, nodes: [...this.project.nodes, node] }, node));
    });
    this.menuContext = { point, anchor, attach, required, compatible, cancel: detached && edge ? () => this.disconnect(edge.to, edge.input) : undefined };
    el("node-categories").replaceChildren();
    this.search.value = "";
    this.menu.show();
    this.renderMenu();
    this.search.focus();
  }

  private closeMenu(chosen = false, focusGraph = true) {
    const context = this.menuContext;
    this.menuContext = undefined;
    this.menu.close();
    if (!chosen) context?.cancel?.();
    if (focusGraph) this.graph.focus({ preventScroll: true });
  }

  private renderMenu() {
    const context = this.menuContext;
    if (!context) return;
    const query = this.search.value.trim();
    const categories = el("node-categories");
    const results = el("node-results");
    const panel = el("node-results-panel");
    if (!categories.childElementCount) {
      categories.append(...groups.filter(group => context.compatible.some(kind => nodes[kind].group === group)).map(group => {
        const category = button(group, () => {
          const current = this.menuContext;
          if (!current) return;
          this.search.value = "";
          current.category = group;
          this.renderMenu();
          results.querySelector("button")?.focus();
        }, "menu-category");
        category.dataset.group = group;
        category.setAttribute("aria-controls", "node-results-panel");
        category.append(make("span", "›"));
        category.onpointerenter = event => {
          if (event.pointerType === "touch" || this.search.value || !this.menuContext) return;
          this.menuContext.category = group;
          this.renderMenu();
        };
        return category;
      }));
      if (!context.compatible.length) categories.append(make("p", "No compatible nodes", "menu-empty"));
    }
    for (const category of categories.querySelectorAll("button")) category.setAttribute("aria-expanded", String(category.dataset.group === context.category));
    panel.hidden = !query && !context.category;
    el("node-menu-heading").textContent = context.category ?? "Search results";
    if (context.category) el("node-menu-heading").dataset.group = context.category;
    else delete el("node-menu-heading").dataset.group;
    results.replaceChildren(...catalog(context.compatible, query, context.category).map(choice => {
      const item = button(choice.label, () => {
        if (this.add(choice.kind, context.point, choice.params, context.attach, context.required)) this.closeMenu(true);
      }, "menu-result");
      item.dataset.group = choice.group;
      if (query) item.append(make("small", choice.group));
      this.attachDrag(item, choice);
      return item;
    }));
    if (!panel.hidden && !results.childElementCount) results.append(make("p", "No matching nodes", "menu-empty"));
    this.menu.style.left = `${Math.max(6, Math.min(context.anchor.x, this.graph.clientWidth - this.menu.offsetWidth - 6))}px`;
    this.menu.style.top = `${Math.max(6, Math.min(context.anchor.y, this.graph.clientHeight - this.menu.offsetHeight - 6))}px`;
  }
}

new Editor();
