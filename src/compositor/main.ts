import "./style.css";
import { analyze, connect, demo, example, inputKey, kinds, makeNode, nodes, projectFromJson, GraphError,
  type Edge, type GraphNode, type Kind, type Project, type SocketType, type Value } from "./graph";
import { Renderer } from "./gpu";
import { Storage, type LocalAsset } from "./media";
import { Session } from "./session";

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
const mediaDrag = "application/x-nodesdevil-video";
const typeNames: Record<SocketType, string> = { image: "Image", color: "Color", float: "Float", bool: "Boolean", vec2: "Vector" };
type Point = { x: number; y: number };

class Editor {
  private project = example();
  private selection?: string;
  private viewer?: string;
  private runtime?: Session;
  private unavailable = "";
  private note = "";
  private noteError = false;
  private updateTimer?: number;
  private zoom = 1;
  private pan: Point = { x: 22, y: 22 };
  private pending?: string;
  private lastPoint?: Point;
  private readonly graph = el("graph");
  private readonly scene = el("scene");
  private readonly wires = document.querySelector<SVGSVGElement>("#wires")!;
  private readonly cards = el("cards");
  private readonly menu = el<HTMLDialogElement>("node-menu");
  private readonly search = el<HTMLInputElement>("node-search");
  private readonly bpm = el<HTMLInputElement>("bpm");
  private readonly save = el<HTMLButtonElement>("save");
  private readonly load = el<HTMLButtonElement>("load");
  private readonly take = el<HTMLButtonElement>("take");
  private readonly storage = new Storage();
  private readonly assets = new Map<string, LocalAsset>();
  private readonly cardsById = new Map<string, HTMLElement>();
  private readonly outlets = new Map<string, HTMLButtonElement>();
  private readonly inlets = new Map<string, HTMLButtonElement>();

  constructor() {
    el("add-node").onclick = () => this.openMenu();
    el("fit").onclick = () => this.fit();
    this.bpm.onchange = () => {
      const bpm = this.bpm.valueAsNumber;
      if (!Number.isFinite(bpm) || bpm < 1 || bpm > 480) { this.bpm.value = String(this.project.bpm); return; }
      this.edit({ ...this.project, bpm });
    };
    this.take.onclick = () => this.requestTake();
    this.save.onclick = () => { void this.storage.save(this.project).then(() => this.report("Project saved in this browser."), error => this.report(String(error), true)); };
    this.load.onclick = () => { void this.storage.load().then(saved => {
      if (saved) this.loadProject(saved);
      this.report(saved ? "Saved project opened in Preview." : "No saved compositor project yet.");
    }, error => this.report(String(error), true)); };
    el("projection").onclick = () => {
      if (!this.runtime?.openOutput()) this.report("Could not open the output window. Allow pop-ups for this page.", true);
    };
    el("view-output").onclick = () => {
      this.viewer = undefined;
      this.queueUpdate();
      this.renderSelection();
    };
    const files = el<HTMLInputElement>("files");
    el("import").onclick = () => files.click();
    files.onchange = () => { void this.importFiles([...files.files ?? []]); files.value = ""; };
    this.dropTarget(el("media"), event => this.importFiles([...event.dataTransfer!.files]));
    this.dropTarget(this.graph, async event => {
      const data = event.dataTransfer!;
      const point = this.inScene(event);
      const asset = data.getData(mediaDrag);
      if (this.assets.has(asset) || Object.hasOwn(demo, asset)) this.add("video", point, { asset });
      else await this.importFiles([...data.files], point);
    });
    this.search.oninput = () => this.renderMenu();
    this.search.onkeydown = event => {
      if (event.key === "Enter") el("node-results").querySelector("button")?.click();
      if (event.key === "Escape") this.closeMenu();
    };
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
      if (this.pending) this.renderWires();
    });
    this.graph.addEventListener("keydown", event => {
      if (event.target !== this.graph) return;
      if (event.key === "Delete" || event.key === "Backspace") this.removeSelection();
      if (event.key === "Escape") { this.pending = undefined; this.renderWires(); }
      if (event.key === "Tab" && !event.shiftKey && this.menu.open) this.search.focus();
      if (event.key.toLowerCase() === "a" && !event.ctrlKey && !event.metaKey) this.openMenu();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.requestTake(); }
    });
    new ResizeObserver(() => this.renderWires()).observe(this.graph);
    this.renderAssets();
    this.renderGraph();
    this.renderInspector();
    this.fit();
    void this.initialize();
  }

  private async initialize() {
    try {
      const renderer = await Renderer.create();
      this.runtime = new Session(renderer, el<HTMLCanvasElement>("preview"));
      this.runtime.onChange = () => this.updateStatus();
      this.exposeMetrics();
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : String(error);
    }
    try {
      const assets = await this.storage.list();
      for (const asset of assets) {
        this.assets.set(asset.id, asset);
        this.runtime?.media.assets.set(asset.id, asset);
      }
      this.renderAssets();
      this.renderGraph();
      this.renderInspector();
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
    this.project = project;
    this.note = "";
    if (redraw) { this.renderGraph(); this.renderInspector(); }
    else this.updateBriefs();
    this.queueUpdate();
  }

  private loadProject(project: Project) {
    this.viewer = this.selection = this.pending = undefined;
    this.bpm.value = String(project.bpm);
    this.edit(project);
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
    const details = el("inspector-error");
    if (details) details.textContent = this.selection ? messages.get(this.selection) ?? "" : "";
  }

  private async importFiles(files: File[], at?: Point) {
    const videos = files.filter(file => file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name));
    if (!videos.length) { this.report("Choose a video file.", true); return; }
    try {
      const imported = [];
      for (const file of videos) {
        const asset = await this.storage.add(file);
        imported.push(asset);
        this.assets.set(asset.id, asset);
        this.runtime?.media.assets.set(asset.id, asset);
      }
      this.renderAssets();
      if (at) {
        imported.forEach((asset, index) => this.add("video", { x: at.x, y: at.y + index * 108 }, { asset: asset.id }));
      }
      this.report(`${imported.length} video${imported.length === 1 ? "" : "s"} imported.`);
    } catch (error) { this.report(`Import failed: ${String(error)}`, true); }
  }

  private dropTarget(element: HTMLElement, onDrop: (event: DragEvent) => void | Promise<void>) {
    element.ondragover = event => {
      if (!event.dataTransfer?.types.some(type => type === "Files" || type === mediaDrag)) return;
      event.preventDefault();
      element.dataset.drop = "true";
    };
    element.ondragleave = event => {
      if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) element.dataset.drop = "false";
    };
    element.ondrop = event => {
      event.preventDefault();
      element.dataset.drop = "false";
      if (event.dataTransfer) void onDrop(event);
    };
  }

  private assetName(id: string) { return this.assets.get(id)?.name ?? demo[id as keyof typeof demo]?.name ?? "Missing video"; }

  private assetOptions() {
    return [...Object.entries(demo).map(([id, asset]) => [id, asset.name] as const),
      ...[...this.assets.values()].map(asset => [asset.id, asset.name] as const)];
  }

  private renderAssets() {
    el("assets").replaceChildren(...this.assetOptions().map(([asset, name]) => {
      const item = button("", () => this.add("video", this.center(), { asset }), "asset");
      item.append(make("span", name), make("small", "Video"));
      item.draggable = true;
      item.ondragstart = event => event.dataTransfer?.setData(mediaDrag, asset);
      return item;
    }));
  }

  private showValue(item: GraphNode) {
    if (item.kind === "video") return this.assetName(String(item.params.asset));
    if (item.kind === "time") return String(item.params.unit);
    if (item.kind === "merge") return String(item.params.mode);
    if (item.kind === "math") return String(item.params.operation);
    if (item.kind === "steps") return `${String(item.params.grid).split(",").length} steps`;
    if (item.kind === "expression") return String(item.params.code);
    if (item.kind === "value" || item.kind === "boolean") return String(item.params.value);
    return "";
  }

  private updateBriefs() {
    for (const item of this.project.nodes) {
      const brief = this.cardsById.get(item.id)?.querySelector(".node-brief");
      if (brief) brief.textContent = this.showValue(item);
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
      card.style.left = `${item.x}px`;
      card.style.top = `${item.y}px`;
      this.cardsById.set(item.id, card);
      const header = make("header", def.label, "node-head");
      header.onpointerdown = event => this.startMove(event, item, card);
      header.onclick = () => { if (this.selection !== item.id) this.select(item.id); };
      card.append(header);
      card.onpointerdown = event => {
        if (!(event.target as Element).closest("button, header") && this.selection !== item.id) this.select(item.id);
      };
      if (item.kind !== "output") {
        const port = make("div", typeNames[def.output], "port out");
        port.dataset.type = def.output;
        const socket = button("", () => {});
        socket.setAttribute("aria-label", `${def.label} ${typeNames[def.output]} output`);
        socket.title = socket.getAttribute("aria-label")!;
        socket.onpointerdown = event => this.startCable(event, item.id, socket);
        socket.onclick = event => { if (event.detail === 0) this.setPending(item.id); };
        this.outlets.set(item.id, socket);
        port.append(socket);
        card.append(port);
      }
      for (const [key, input] of Object.entries(def.inputs)) {
        const port = make("div", input.label, "port");
        port.dataset.type = input.type;
        const socket = button("", () => this.finishCable(item.id, key));
        socket.dataset.to = item.id;
        socket.dataset.input = key;
        socket.setAttribute("aria-label", `${def.label} ${input.label} input`);
        const hint = analyzed.conversions.get(inputKey(item.id, key));
        socket.title = hint || `${input.label} · ${typeNames[input.type]}`;
        socket.oncontextmenu = event => { event.preventDefault(); this.disconnect(item.id, key); };
        this.inlets.set(inputKey(item.id, key), socket);
        port.append(socket);
        card.append(port);
      }
      if (this.showValue(item)) card.append(make("div", this.showValue(item), "node-brief"));
      return card;
    }));
    this.renderSelection();
    this.renderWires();
  }

  private select(id?: string) {
    this.selection = this.viewer = id;
    this.renderSelection();
    this.renderInspector();
    this.queueUpdate();
  }

  private renderSelection() {
    for (const [id, card] of this.cardsById) card.dataset.selected = String(id === this.selection);
    const target = this.project.nodes.find(item => item.id === this.viewer);
    el("preview-label").textContent = target ? nodes[target.kind].label : "Output";
  }

  private changeParam(id: string, key: string, value: Value) {
    this.edit({ ...this.project, nodes: this.project.nodes.map(item =>
      item.id === id ? { ...item, params: { ...item.params, [key]: value } } : item) }, false);
  }

  private renderInspector() {
    const root = el("inspector-body");
    const item = this.project.nodes.find(node => node.id === this.selection);
    if (!item) {
      el("inspector-heading").textContent = "Inspector";
      root.textContent = "Select a node to edit it.";
      return;
    }
    const def = nodes[item.kind];
    el("inspector-heading").textContent = def.label;
    root.replaceChildren();
    const error = make("p", "", "error");
    error.id = "inspector-error";
    error.setAttribute("role", "alert");
    root.append(error);
    for (const [key, param] of Object.entries(def.parameters)) {
      if (item.kind === "steps" && key === "grid") { this.stepEditor(item, root); continue; }
      const value = item.params[key];
      if (param.options || key === "asset") {
        const select = make("select");
        const options = param.options?.map(entry => [entry, entry] as const) ?? this.assetOptions();
        for (const [id, name] of options) { const option = make("option", name); option.value = id; select.append(option); }
        select.value = String(value);
        select.onchange = () => this.changeParam(item.id, key, select.value);
        root.append(this.field(param.label, select));
      } else if (key === "code") {
        const area = make("textarea");
        area.value = String(value);
        area.spellcheck = false;
        area.oninput = () => this.changeParam(item.id, key, area.value);
        root.append(this.field(param.label, area));
        root.append(make("p", "Returns a Float. Inputs: a, b, uv, time.", "expression-help"));
      } else {
        root.append(this.field(param.label, this.control(value, next => this.changeParam(item.id, key, next), param.step, param.min, param.max)));
      }
    }
    for (const [key, input] of Object.entries(def.inputs)) {
      const signal = this.project.edges.find(edge => edge.to === item.id && edge.input === key);
      if (signal) {
        const source = this.project.nodes.find(node => node.id === signal.from)!;
        root.append(this.field(input.label, button(`${nodes[source.kind].label} ×`, () => this.disconnect(item.id, key), "quiet")));
      } else if (input.value !== undefined) {
        const value = item.params["input:" + key] ?? input.value;
        root.append(this.field(input.label, this.control(value, next => this.changeParam(item.id, "input:" + key, next), 0.01)));
      }
    }
    root.append(button("Delete Node", () => this.removeSelection(), "quiet"));
    this.updateStatus();
  }

  private stepEditor(item: GraphNode, root: HTMLElement) {
    const grid = make("div", "", "step-grid");
    const values = String(item.params.grid).split(",").map(Number);
    for (const [index, value] of values.entries()) {
      const step = make("label", `Step ${index + 1}`, "step");
      step.append(this.control(value, next => {
        values[index] = Number(next);
        this.changeParam(item.id, "grid", values.join(","));
      }, 0.05, 0, 1));
      grid.append(step);
    }
    root.append(grid);
  }

  private field(label: string, control: HTMLElement) {
    const field = make("label", "", "field");
    field.append(make("span", label), control);
    return field;
  }

  private control(value: Value, set: (next: Value) => void, step?: number, min?: number, max?: number) {
    const input = make("input");
    input.type = typeof value === "number" ? "number" : typeof value === "boolean" ? "checkbox" : "color";
    input.value = String(value);
    input.checked = value === true;
    if (step !== undefined) input.step = String(step);
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.oninput = () => {
      if (input.type === "number" && (!Number.isFinite(input.valueAsNumber) ||
          input.validity.rangeUnderflow || input.validity.rangeOverflow)) return;
      set(input.type === "number" ? input.valueAsNumber : input.type === "checkbox" ? input.checked : input.value);
    };
    return input;
  }

  private add(kind: Kind, point: Point, params: Record<string, Value> = {}) {
    const node = makeNode(kind, Math.round(point.x), Math.round(point.y), undefined, params);
    this.viewer = this.selection = node.id;
    this.edit({ ...this.project, nodes: [...this.project.nodes, node] });
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
    this.graph.focus({ preventScroll: true });
    this.select(item.id);
    const start = this.inScene(event);
    let x = item.x, y = item.y;
    this.drag(event, next => {
      const pos = this.inScene(next);
      x = Math.round(item.x + pos.x - start.x);
      y = Math.round(item.y + pos.y - start.y);
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      this.renderWires();
    }, () => {
      this.project = { ...this.project, nodes: this.project.nodes.map(node => node.id === item.id ? { ...node, x, y } : node) };
    });
  }

  private startPan(event: PointerEvent) {
    if (event.button !== 0 && event.button !== 1 || (event.target as Element).closest(".node, .node-menu, .wire-hit")) return;
    this.graph.focus({ preventScroll: true });
    this.pending = undefined;
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

  private startCable(event: PointerEvent, id: string, socket: HTMLButtonElement) {
    if (event.button !== 0) return;
    this.lastPoint = this.inScene(event);
    this.setPending(id);
    const start = { x: event.clientX, y: event.clientY };
    this.drag(event, next => { this.lastPoint = this.inScene(next); this.renderWires(); }, () => {
      socket.focus({ preventScroll: true });
      const last = this.lastPoint ?? this.inScene(event);
      const bounds = this.scene.getBoundingClientRect();
      const x = bounds.left + last.x * this.zoom, y = bounds.top + last.y * this.zoom;
      if (Math.hypot(x - start.x, y - start.y) < 4) return;
      const inlet = document.elementFromPoint(x, y)?.closest<HTMLButtonElement>("button[data-to]");
      if (inlet) this.finishCable(inlet.dataset.to!, inlet.dataset.input!);
      else this.setPending(undefined);
    });
  }

  private setPending(id?: string) {
    this.pending = id;
    this.renderWires();
  }

  private finishCable(to: string, input: string) {
    if (!this.pending) return;
    try {
      const project = connect(this.project, { from: this.pending, to, input });
      this.pending = undefined;
      this.edit(project);
    } catch (error) { this.report(error instanceof Error ? error.message : String(error), true); }
  }

  private disconnect(to: string, input: string) {
    if (!this.project.edges.some(edge => edge.to === to && edge.input === input)) return;
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

  private renderWires() {
    const analyzed = analyze(this.project);
    this.wires.replaceChildren();
    const socketPoint = (socket: HTMLButtonElement) => {
      const box = socket.getBoundingClientRect();
      return this.inScene({ clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });
    };
    for (const edge of this.project.edges) {
      const from = this.outlets.get(edge.from), to = this.inlets.get(inputKey(edge.to, edge.input));
      if (!from || !to) continue;
      const group = document.createElementNS(svg, "g");
      const title = document.createElementNS(svg, "title");
      title.textContent = analyzed.conversions.get(inputKey(edge.to, edge.input)) ||
        `${nodes[analyzed.byId.get(edge.from)!.kind].label} → ${nodes[analyzed.byId.get(edge.to)!.kind].label}`;
      const fromPoint = socketPoint(from), toPoint = socketPoint(to);
      const hit = this.wire(fromPoint, toPoint, "wire-hit");
      hit.oncontextmenu = event => { event.preventDefault(); this.disconnect(edge.to, edge.input); };
      group.append(title, this.wire(fromPoint, toPoint, "wire", analyzed.signals.get(edge.from)!.type), hit);
      this.wires.append(group);
    }
    for (const [id, outlet] of this.outlets) outlet.dataset.pending = String(id === this.pending);
    const from = this.pending ? this.outlets.get(this.pending) : undefined;
    if (from && this.lastPoint) this.wires.append(this.wire(socketPoint(from), this.lastPoint, "wire wire-pending"));
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
    this.graph.style.backgroundSize = `${20 * this.zoom}px ${20 * this.zoom}px`;
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

  private openMenu() {
    this.search.value = "";
    this.renderMenu();
    if (!this.menu.open) this.menu.show();
    this.search.focus();
  }

  private closeMenu() { this.menu.close(); this.graph.focus({ preventScroll: true }); }

  private renderMenu() {
    const search = this.search.value.trim().toLowerCase();
    const choices = kinds.filter(kind => `${nodes[kind].label} ${nodes[kind].group}`.toLowerCase().includes(search));
    el("node-results").replaceChildren(...choices.map(kind => {
      const node = button(nodes[kind].label, () => { this.add(kind, this.center()); this.closeMenu(); }, "quiet");
      node.append(make("small", nodes[kind].group));
      return node;
    }));
  }
}

new Editor();
