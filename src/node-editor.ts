import {
  definition, fftBands, fontAxes, fontAxisFor, inputsFor, keepCompatibleEdges, makeNode, MIN_GRAPH_ZOOM, modeFor, nodeKinds, outputType,
  previewType, valueTypes, variableFor, withEdge, type Graph, type GraphEdge, type GraphNode,
  type Literal, type NodeDrop, type NodeMode, type ValueType,
} from "./node-graph";
import type { PreviewTarget } from "./node-runtime";
import { setSidebarDropReceiver } from "./node-sidebar-drag";
import { getAllEntries, type MediaEntry } from "./media-registry";
import { FONT_AXES } from "./font-list";

export interface GraphView { x: number; y: number; zoom: number; previews: string[] }
interface Options {
  graph: Graph;
  view: GraphView;
  save(graph: Graph, view: GraphView): void;
  run(graph: Graph, restart: boolean): string | null;
  showCode(): void;
  openOutput(): void;
  bindProjectionToggle(button: HTMLButtonElement): void;
}
interface Point { x: number; y: number }
interface Port { node: string; input?: string }
interface PendingCable { fixedPorts: Port[]; detached: GraphEdge[] }
type AttachNode = (graph: Graph, node: GraphNode) => Graph | undefined;
interface MenuChoice { drop: NodeDrop; name: string; category: string; modes?: NodeMode[]; search: string[] }
const svgNamespace = "http://www.w3.org/2000/svg";
const typeLabels: Record<ValueType, string> = { visual: "Image", number: "Float", text: "Text", boolean: "Boolean" };
const categoryIcons: Record<string, string> = {
  Sources: "▣", Signals: "∿", Playback: "▶", Layout: "▦", Image: "◐", Text: "T", Variables: "{}", Output: "↗",
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

function button(label: string, action: () => void, className = "nd-button") {
  const el = element("button", className, label);
  el.type = "button";
  el.addEventListener("click", action);
  return el;
}

function select(values: [string, string][], value: string, label: string, onChange: (value: string) => void) {
  const el = element("select", "nd-field");
  el.setAttribute("aria-label", label);
  for (const [id, name] of values) el.add(new Option(name, id));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

function searchWords(text: string) {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function oneEdit(a: string, b: string) {
  if (a.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length > b.length) return a.slice(i + 1) === b.slice(i);
  if (b.length > a.length) return a.slice(i) === b.slice(i + 1);
  return a.slice(i + 1) === b.slice(i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}

function matchNode(query: string[], text: string) {
  const words = searchWords(text);
  const joined = words.join("");
  const key = query.join("");
  if (joined === key) return 100;
  if (joined.startsWith(key)) return 85;
  if (query.every(part => words.some(word => word.startsWith(part)))) return 75;
  if (joined.includes(key)) return 65;
  if (query.every(part => words.some(word => word.includes(part) || oneEdit(part, word)))) return 40;
  return 0;
}

function createNodeMenu(choices: MenuChoice[], choose: (drop: NodeDrop) => void) {
  const browser = element("div", "nd-menu-browser");
  const left = element("div", "nd-menu-panel nd-menu-categories");
  const search = element("input", "nd-search");
  search.type = "search";
  search.placeholder = "Search nodes…";
  search.setAttribute("aria-label", "Search nodes");
  const categories = element("div", "nd-menu-category-list");
  categories.setAttribute("role", "group");
  categories.setAttribute("aria-label", "Node categories");
  left.append(search, categories);
  const results = element("section", "nd-menu-panel nd-menu-results");
  const heading = element("h2", "nd-menu-heading");
  const list = element("div", "nd-menu-list");
  results.id = "nd-node-menu-results";
  heading.id = "nd-node-menu-heading";
  results.setAttribute("aria-labelledby", heading.id);
  results.append(heading, list);
  browser.append(left, results);

  let query: string[] = [];
  let active: string | undefined;
  const tabs = new Map<string, HTMLButtonElement>();
  function show(category?: string) {
    active = category;
    for (const [name, tab] of tabs) tab.setAttribute("aria-expanded", String(name === active));
    results.hidden = !active && !query.length;
    if (active) heading.dataset.category = active;
    else delete heading.dataset.category;
    heading.textContent = active ?? "Search results";
    list.replaceChildren();
    if (results.hidden) return;

    const matches = choices.flatMap(choice => {
      if (!query.length && choice.category !== active) return [];
      const [firstMode] = choice.modes ?? [];
      let mode = firstMode;
      const nameScore = query.length ? Math.max(...choice.search.map(text => matchNode(query, text))) : 0;
      let score = nameScore;
      let matchingMode = false;
      for (const option of query.length ? choice.modes ?? [] : []) {
        const terms = [option.label, `${choice.name} ${option.label}`, ...(option.reference ?? []), ...(option.aliases ?? [])];
        const rank = Math.max(...terms.map(text => matchNode(query, text)));
        if (rank > score) {
          score = rank;
          mode = option;
          matchingMode = true;
        }
      }
      if (query.length && !score) {
        score = matchNode(query, choice.category) / 4;
        if (!score) return [];
      }
      return [{
        name: mode && (matchingMode || mode !== definition(choice.drop.kind).modes?.[0]) ? `${choice.name} · ${mode.label}` : choice.name,
        drop: mode ? { ...choice.drop, data: { ...choice.drop.data, mode: mode.id } } : choice.drop,
        category: choice.category, score,
      }];
    });
    if (query.length) matches.sort((a, b) => b.score - a.score);
    for (const item of matches) {
      const row = button(item.name, () => choose(item.drop), "nd-menu-item");
      row.dataset.category = item.category;
      row.title = item.name;
      if (query.length) {
        const label = element("span", "nd-menu-result-category", item.category);
        label.setAttribute("aria-hidden", "true");
        row.append(label);
      }
      list.append(row);
    }
    if (!matches.length) list.append(element("p", "nd-menu-empty", query.length ? "No matching nodes" : "No compatible nodes"));
  }

  for (const category of new Set(choices.map(choice => choice.category))) {
    const tab = button(category, () => {}, "nd-menu-category");
    tab.dataset.category = category;
    tab.setAttribute("aria-controls", results.id);
    const icon = element("span", "nd-menu-icon", categoryIcons[category]);
    icon.setAttribute("aria-hidden", "true");
    tab.prepend(icon);
    tab.addEventListener("pointermove", event => {
      if (!query.length && event.buttons === 0 && event.pointerType !== "touch" && category !== active) show(category);
    });
    tab.addEventListener("click", event => {
      const collapse = event instanceof PointerEvent && event.pointerType === "touch" && category === active;
      search.value = "";
      query = [];
      show(collapse ? undefined : category);
      if (event.detail === 0) list.querySelector("button")?.focus();
    });
    tabs.set(category, tab);
    categories.append(tab);
  }
  if (!choices.length) categories.append(element("p", "nd-menu-empty", "No compatible nodes"));
  browser.addEventListener("pointerleave", event => {
    if (!query.length && event.pointerType !== "touch" && !results.contains(document.activeElement)) show();
  });
  search.addEventListener("pointerenter", () => { if (!query.length && active) show(); });
  search.addEventListener("input", () => { query = searchWords(search.value); show(); });
  search.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const first = list.querySelector("button");
    if (event.key === "Enter" && query.length) first?.click();
    else (first ?? categories.querySelector("button"))?.focus();
  });
  browser.addEventListener("keydown", event => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const tab = event.target.closest<HTMLButtonElement>(".nd-menu-category");
    if (event.key === "ArrowRight" && tab) {
      event.preventDefault();
      tab.click();
    } else if (event.key === "ArrowLeft" && !tab) {
      event.preventDefault();
      (tabs.get(active ?? "") ?? search).focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = Array.from((tab ? categories : list).querySelectorAll("button"));
      const next = rows[rows.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : -1)];
      (next ?? (event.key === "ArrowUp" ? search : event.target)).focus();
    }
  });
  show();
  return { browser, search };
}

export class NodeEditor {
  graph: Graph;
  readonly view: GraphView;
  private past: Graph[] = [];
  private future: Graph[] = [];
  private selected?: string;
  private selectedEdge?: GraphEdge;
  private viewport = element("div", "nd-viewport");
  private world = element("div", "nd-world");
  private wires = document.createElementNS(svgNamespace, "svg");
  private menu = element("div", "nd-menu");
  private dismissMenu?: () => void;
  private variables = element("div", "nd-variables");
  private ghost = element("div", "nd-drop-ghost");
  private status = element("span", "nd-status");
  private runButton: HTMLButtonElement;
  private undoButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private zoomLabel = element("span", "nd-zoom", "100%");
  private previews: PreviewTarget[] = [];
  private cards = new Map<string, HTMLElement>();
  private edgePaths: { edge: GraphEdge; path: SVGPathElement }[] = [];
  private wireDrag?: { ports: Port[]; point: Point; detached: GraphEdge[] };
  private cancelDrag?: () => void;
  private insertOn?: GraphEdge;
  private applied?: Graph;
  private mediaSignature = "";

  constructor(private host: HTMLElement, private options: Options) {
    this.graph = options.graph;
    this.view = options.view;
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute("aria-label", "Node graph");
    this.wires.classList.add("nd-wires");
    this.menu.hidden = this.variables.hidden = this.ghost.hidden = true;
    this.status.setAttribute("role", "status");
    const top = element("div", "nd-toolbar");
    const brand = element("strong", "nd-brand", "NodesDevil");
    const add = button("+ Add Node", () => this.openMenu({ x: 26, y: 22 }));
    this.undoButton = button("↶", () => this.undo());
    this.undoButton.title = "Undo";
    this.undoButton.setAttribute("aria-label", "Undo");
    this.redoButton = button("↷", () => this.redo());
    this.redoButton.title = "Redo";
    this.redoButton.setAttribute("aria-label", "Redo");
    this.runButton = button("▶ Run", () => this.run(), "nd-button nd-run");
    this.runButton.title = "Run graph (Ctrl/Cmd+Enter)";
    const projection = element("button", "nd-button", "Projection");
    projection.type = "button";
    options.bindProjectionToggle(projection);
    top.append(brand, add, button("Variables", () => this.toggleVariables()), this.undoButton, this.redoButton,
      this.runButton, this.status, projection, button("Open Output ↗", options.openOutput), button("Code", options.showCode));
    const navigation = element("div", "nd-navigation");
    navigation.append(button("−", () => this.centerZoom(1 / 1.2)), this.zoomLabel, button("+", () => this.centerZoom(1.2)), button("Frame All", () => this.fit()));
    this.viewport.append(this.wires, this.world, this.ghost, navigation, this.menu, this.variables);
    host.append(top, this.viewport);
    this.viewport.addEventListener("pointerdown", event => this.startPan(event));
    this.viewport.addEventListener("contextmenu", event => {
      if ((event.target as Element).closest(".nd-node, .nd-menu, .nd-variables, .nd-navigation")) return;
      event.preventDefault();
      this.openMenu(this.local(event.clientX, event.clientY));
    });
    this.viewport.addEventListener("wheel", event => {
      if ((event.target as Element).closest(".nd-menu, .nd-variables, input, select")) return;
      event.preventDefault();
      this.zoom(Math.exp(-event.deltaY * 0.0017), this.local(event.clientX, event.clientY));
      this.save();
    }, { passive: false });
    // A click from releasing a cable must leave the menu it just opened visible.
    let pressedMenu: Element | null = null;
    document.addEventListener("pointerdown", () => {
      pressedMenu = this.menu.hidden ? null : this.menu.firstElementChild;
    }, { capture: true });
    document.addEventListener("click", event => {
      const alreadyOpen = pressedMenu === this.menu.firstElementChild;
      pressedMenu = null;
      if (!this.menu.hidden && (alreadyOpen || event.detail === 0) && !this.menu.contains(event.target as Node)) this.closeMenu();
    }, { capture: true });
    document.addEventListener("keydown", event => this.keydown(event));
    new ResizeObserver(() => this.drawWires()).observe(this.viewport);
    setSidebarDropReceiver((drop, x, y, commit) => this.receive(drop, x, y, commit));
    this.render();
  }

  get visible() { return !this.host.hidden; }

  visiblePreviews(): PreviewTarget[] {
    if (!this.visible || document.hidden) return [];
    const viewport = this.viewport.getBoundingClientRect();
    return this.previews.filter(({ element }) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
    });
  }

  mediaChanged() {
    const entries = getAllEntries();
    const signature = JSON.stringify(entries.map(({ id, name, unavailable }) => [id, name, unavailable]));
    if (this.mediaSignature === signature) return;
    this.mediaSignature = signature;
    this.graph = { ...this.graph };
    for (const node of this.graph.nodes) {
      const card = this.cards.get(node.id);
      if (node.kind === "media" && card) this.updateMediaCard(card, node, entries);
    }
  }

  refresh() { this.render(); }

  loadExample(graph: Graph) {
    this.closeMenu();
    this.variables.hidden = true;
    this.selectNode();
    this.change(graph);
    this.fit();
    this.run(graph, true);
  }

  run(graph = this.graph, restart = false) {
    const error = this.options.run(graph, restart);
    if (!error) this.applied = graph;
    this.status.textContent = error ?? "Running";
    this.status.classList.toggle("error", Boolean(error));
    this.refreshHistory();
  }

  private change(graph: Graph) {
    this.past.push(this.graph);
    if (this.past.length > 75) this.past.shift();
    this.future.length = 0;
    this.graph = graph;
    this.status.textContent = "Changes ready to run";
    this.status.classList.remove("error");
    this.save();
    this.render();
  }

  private undo() {
    const graph = this.past.pop();
    if (!graph) return;
    this.future.push(this.graph);
    this.graph = graph;
    this.status.textContent = this.applied === this.graph ? "Running" : "Changes ready to run";
    this.status.classList.remove("error");
    this.save();
    this.render();
  }

  private redo() {
    const graph = this.future.pop();
    if (!graph) return;
    this.past.push(this.graph);
    this.graph = graph;
    this.status.textContent = this.applied === this.graph ? "Running" : "Changes ready to run";
    this.status.classList.remove("error");
    this.save();
    this.render();
  }

  private refreshHistory() {
    this.undoButton.disabled = !this.past.length;
    this.redoButton.disabled = !this.future.length;
    this.runButton.classList.toggle("pending", this.applied !== this.graph);
  }

  private save() { this.options.save(this.graph, this.view); }

  private render() {
    const existing = new Map(this.previews.map(target => [target.id, target]));
    this.previews = [];
    this.world.replaceChildren();
    this.cards.clear();
    for (const node of this.graph.nodes) this.renderNode(node, existing.get(node.id));
    this.transform();
    this.refreshHistory();
    if (!this.variables.hidden) this.renderVariables();
  }

  private renderNode(node: GraphNode, previous?: PreviewTarget) {
    const def = definition(node.kind);
    const card = element("article", "nd-node");
    card.dataset.nodeId = node.id;
    card.dataset.kind = node.kind;
    card.dataset.category = def.category;
    card.classList.toggle("is-selected", node.id === this.selected);
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    const header = element("header", "nd-node-head");
    const entries = node.kind === "media" ? getAllEntries() : [];
    const media = entries.find(item => item.id === node.data.media);
    const title = element("span", "nd-node-title", media?.name ?? def.label);
    header.append(title);
    header.addEventListener("pointerdown", event => this.startNodeMove(event, node));
    const type = previewType(this.graph, node);
    if (type) {
      const open = this.view.previews.includes(node.id);
      const toggle = button(open ? "▾" : "▸", () => {
        this.view.previews = open ? this.view.previews.filter(id => id !== node.id) : [...this.view.previews, node.id];
        this.save();
        this.render();
        this.cards.get(node.id)?.querySelector<HTMLButtonElement>(".nd-preview-toggle")?.focus();
      }, "nd-preview-toggle");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `Preview ${media?.name ?? def.label}`);
      header.append(toggle);
    }
    card.append(header);
    const body = element("div", "nd-node-body");
    if (def.modes) {
      const setting = element("label", "nd-node-mode", "Mode");
      const mode = select(def.modes.map(item => [item.id, item.label]), modeFor(node)?.id ?? "", "Mode", value => {
        this.setData(node, "mode", value);
        this.cards.get(node.id)?.querySelector<HTMLSelectElement>(".nd-node-mode select")?.focus();
      });
      setting.append(mode);
      body.append(setting);
    }
    if (node.kind === "media") {
      body.append(select([], "", "Media", value => this.setData(node, "media", value)));
      body.append(element("small", "nd-node-error", "Media unavailable"));
    }
    if (node.kind === "fft") {
      body.append(select(fftBands.map((band, index) => [band, ["Volume", "Bass", "Mid", "Treble"][index]]), String(node.data.band ?? "bass"), "FFT band", value => this.setData(node, "band", value)));
    }
    if (node.kind === "get" || node.kind === "set") {
      const choices = this.graph.variables.filter(variable => node.kind === "get" || !this.graph.nodes.some(other => other.id !== node.id && other.kind === "set" && other.data.variable === variable.id));
      body.append(select([["", "Choose variable…"], ...choices.map(item => [item.id, item.name] as [string, string])], String(node.data.variable ?? ""), "Variable", value => this.setData(node, "variable", value)));
    }
    const output = outputType(this.graph, node);
    if (output) {
      const row = element("div", "nd-port-row nd-port-out");
      row.dataset.type = output;
      row.append(element("span", "", output === "visual" ? "Image" : "Value"), this.port(node, output));
      body.append(row);
    }
    for (const socket of inputsFor(this.graph, node)) {
      const fontAxis = node.kind === "fontAxis" && socket.id === "tag";
      const row = element(fontAxis ? "div" : "label", "nd-port-row");
      row.dataset.type = socket.type;
      const connected = this.graph.edges.some(edge => edge.to === node.id && edge.input === socket.id);
      row.classList.toggle("nd-connected", connected);
      if (!connected && !socket.optional && socket.default === undefined) row.classList.add("nd-required");
      row.append(this.port(node, socket.type, socket.id), element("span", "", socket.label));
      if (fontAxis && !connected) {
        row.append(this.fontAxisField(node, String(node.data.tag ?? socket.default)));
      } else if (!connected && (socket.optional || socket.default !== undefined)) {
        const input = element("input", "nd-field");
        input.type = socket.type === "boolean" ? "checkbox" : socket.type === "number" ? "number" : "text";
        input.step = "any";
        input.setAttribute("aria-label", socket.label);
        input.value = String(node.data[socket.id] ?? socket.default ?? "");
        if (socket.optional) input.placeholder = node.kind === "scale" ? "Uniform" : node.kind === "grid" ? "Auto" : "—";
        input.checked = (node.data[socket.id] ?? socket.default) === true;
        let editing = false;
        input.addEventListener("blur", () => { editing = false; });
        input.addEventListener("input", () => {
          const value = input.type === "checkbox" ? input.checked
            : socket.optional && input.value === "" ? undefined
            : input.type === "number" ? input.valueAsNumber : input.value;
          if (typeof value === "number" && !Number.isFinite(value)) return;
          this.editLiteral(node.id, socket.id, value, !editing);
          editing = true;
        });
        row.append(input);
      }
      if (fontAxis) body.prepend(row);
      else body.append(row);
    }
    if (node.kind === "output") {
      const outputs = this.graph.nodes.filter(item => item.kind === "output");
      const order = outputs.findIndex(item => item.id === node.id);
      if (outputs.length > 1) body.append(select(outputs.map((_, i) => [String(i), `Layer ${i + 1}`]), String(order), "Layer order", value => this.reorderOutput(node, Number(value))));
    }
    card.append(body);
    if (type && this.view.previews.includes(node.id)) {
      const preview = previous?.element.dataset.type === type ? previous : this.makePreview(node.id, type);
      card.append(preview.element);
      this.previews.push(preview);
    }
    card.addEventListener("contextmenu", event => {
      event.preventDefault();
      this.openActions(node, this.local(event.clientX, event.clientY));
    });
    this.world.append(card);
    this.cards.set(node.id, card);
    if (node.kind === "media") this.updateMediaCard(card, node, entries);
  }

  private fontAxisField(node: GraphNode, tag: string) {
    const field = element("div", "nd-font-axis-field");
    const axis = fontAxisFor(tag);
    const picker = select([...fontAxes.map(({ tag, label }): [string, string] => [tag, label]), ["", "Custom tag…"]], axis?.tag ?? "", "Font axis", value => {
      this.setData(node, "tag", value);
      this.cards.get(node.id)?.querySelector<HTMLElement>(value ? ".nd-font-axis-field select" : ".nd-font-axis-field input")?.focus();
    });
    field.append(picker);
    if (axis) {
      const sample = Object.entries(FONT_AXES).find(([, axes]) => axes.some(item => item.tag === axis.tag))?.[0];
      const hint = axis.tag === "slnt" ? "0° upright · − leans right"
        : axis.tag === "italic" ? "On for italic, off for upright."
        : sample ? `Use a font like ${sample}.` : "Requires a font with this axis.";
      field.append(element("small", "nd-font-axis-hint", hint));
    }
    if (!axis) {
      const custom = element("input", "nd-field");
      custom.setAttribute("aria-label", "Custom axis tag");
      custom.placeholder = "Axis tag";
      custom.value = tag;
      let editing = false;
      custom.addEventListener("blur", () => { editing = false; });
      custom.addEventListener("input", () => {
        this.editLiteral(node.id, "tag", custom.value.trim(), !editing);
        editing = true;
      });
      field.append(custom);
    }
    return field;
  }

  private updateMediaCard(card: HTMLElement, node: GraphNode, entries: MediaEntry[]) {
    const media = entries.find(item => item.id === node.data.media);
    const picker = card.querySelector<HTMLSelectElement>("select")!;
    picker.replaceChildren(new Option("Choose media…", ""), ...entries.map(({ id, name }) => new Option(name, id)));
    picker.value = media?.id ?? "";
    card.querySelector(".nd-node-title")!.textContent = media?.name ?? "Media";
    card.querySelector(".nd-preview-toggle")?.setAttribute("aria-label", "Preview " + (media?.name ?? "Media"));
    card.querySelector<HTMLElement>(".nd-node-error")!.hidden = Boolean(media && !media.unavailable);
  }

  private makePreview(id: string, type: ValueType): PreviewTarget {
    const wrap = element("div", "nd-preview");
    wrap.dataset.type = type;
    const status = element("span", "nd-preview-status", "Loading…");
    const canvas = type === "visual" || type === "number" ? element("canvas", "nd-thumbnail") : undefined;
    if (canvas) {
      canvas.width = 200;
      canvas.height = type === "visual" ? 112 : 36;
      wrap.append(canvas);
    }
    wrap.append(status);
    return { id, element: wrap, canvas, status, samples: [] };
  }

  private port(node: GraphNode, type: ValueType, input?: string) {
    const socket = button("", () => {}, "nd-port");
    socket.dataset.port = node.id;
    socket.dataset.type = type;
    socket.dataset.input = input ?? "";
    const label = input ? inputsFor(this.graph, node).find(item => item.id === input)?.label ?? input : "Output";
    const connected = this.edgesAt({ node: node.id, input }).length > 0;
    socket.title = `${label} · ${typeLabels[type]}${connected ? " · Alt-click to disconnect" : ""}`;
    socket.setAttribute("aria-label", `${definition(node.kind).label} ${input ?? "output"} (${type})`);
    socket.addEventListener("pointerdown", event => this.startWire(event, { node: node.id, input }));
    socket.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openMenu(this.portPosition({ node: node.id, input })!, { node: node.id, input });
    });
    socket.addEventListener("contextmenu", event => {
      if (!input) return;
      event.stopPropagation();
      event.preventDefault();
      const [edge] = this.edgesAt({ node: node.id, input });
      if (edge) this.removeEdge(edge);
    });
    return socket;
  }

  private setData(node: GraphNode, key: string, value: Literal) {
    if (node.data[key] === value) return;
    const data = { ...node.data, [key]: value };
    if (key === "variable") delete data.value;
    if (node.kind === "fontAxis" && key === "tag") {
      const axis = fontAxisFor(value);
      if (typeof axis?.value === "number") data.value = axis.value;
    }
    this.change(keepCompatibleEdges({ ...this.graph, nodes: this.graph.nodes.map(item => item.id === node.id ? { ...item, data } : item) }));
  }

  private editLiteral(id: string, key: string, value: Literal | undefined, first: boolean) {
    const current = this.graph.nodes.find(item => item.id === id);
    if (!current || current.data[key] === value) return;
    if (first) {
      this.past.push(this.graph);
      if (this.past.length > 75) this.past.shift();
      this.future.length = 0;
    }
    const data = { ...current.data };
    if (value === undefined) delete data[key];
    else data[key] = value;
    this.graph = { ...this.graph, nodes: this.graph.nodes.map(item => item === current ? { ...item, data } : item) };
    this.status.textContent = "Changes ready to run";
    this.status.classList.remove("error");
    this.refreshHistory();
    this.save();
  }

  private reorderOutput(node: GraphNode, index: number) {
    const outputs = this.graph.nodes.filter(item => item.kind === "output");
    outputs.splice(outputs.indexOf(node), 1);
    outputs.splice(index, 0, node);
    this.change({ ...this.graph, nodes: this.graph.nodes.map(item => item.kind === "output" ? outputs.shift()! : item) });
  }

  private local(x: number, y: number): Point {
    const rect = this.viewport.getBoundingClientRect();
    return { x: x - rect.left, y: y - rect.top };
  }

  private worldPoint(point: Point): Point {
    return { x: (point.x - this.view.x) / this.view.zoom, y: (point.y - this.view.y) / this.view.zoom };
  }

  private transform() {
    const { x, y, zoom } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.viewport.style.backgroundPosition = `${x}px ${y}px`;
    this.viewport.style.backgroundSize = `${Math.max(10, 20 * zoom)}px ${Math.max(10, 20 * zoom)}px`;
    this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    this.drawWires();
  }

  private zoom(factor: number, at: Point) {
    const anchor = this.worldPoint(at);
    this.view.zoom = Math.max(MIN_GRAPH_ZOOM, Math.min(2.5, this.view.zoom * factor));
    this.view.x = at.x - anchor.x * this.view.zoom;
    this.view.y = at.y - anchor.y * this.view.zoom;
    this.transform();
  }

  private centerZoom(factor: number) {
    this.zoom(factor, { x: this.viewport.clientWidth / 2, y: this.viewport.clientHeight / 2 });
    this.save();
  }

  private fit() {
    if (!this.graph.nodes.length) return;
    const left = Math.min(...this.graph.nodes.map(node => node.x));
    const top = Math.min(...this.graph.nodes.map(node => node.y));
    const right = Math.max(...this.graph.nodes.map(node => node.x + (this.cards.get(node.id)?.offsetWidth ?? 200)));
    const bottom = Math.max(...this.graph.nodes.map(node => node.y + (this.cards.get(node.id)?.offsetHeight ?? 100)));
    this.view.zoom = Math.max(MIN_GRAPH_ZOOM, Math.min(1, (this.viewport.clientWidth - 80) / (right - left), (this.viewport.clientHeight - 105) / (bottom - top)));
    this.view.x = (this.viewport.clientWidth - (right - left) * this.view.zoom) / 2 - left * this.view.zoom;
    this.view.y = (this.viewport.clientHeight - (bottom - top) * this.view.zoom) / 2 - top * this.view.zoom;
    this.transform();
    this.save();
  }

  private portPosition(port: Port): Point | undefined {
    const socket = this.cards.get(port.node)?.querySelector<HTMLElement>(`[data-input="${port.input ?? ""}"]`);
    if (!socket) return;
    const rect = socket.getBoundingClientRect();
    return this.local(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  private wirePath(start: Point, end: Point, type?: ValueType) {
    const path = document.createElementNS(svgNamespace, "path");
    const bend = Math.max(34, Math.abs(end.x - start.x) * 0.45);
    path.setAttribute("d", `M${start.x},${start.y} C${start.x + bend},${start.y} ${end.x - bend},${end.y} ${end.x},${end.y}`);
    if (type) path.dataset.type = type;
    return path;
  }

  private drawWires() {
    this.wires.replaceChildren();
    this.edgePaths = [];
    for (const edge of this.graph.edges) {
      const from = this.portPosition({ node: edge.from });
      const to = this.portPosition({ node: edge.to, input: edge.input });
      const node = this.graph.nodes.find(item => item.id === edge.from);
      if (!from || !to || !node) continue;
      const path = this.wirePath(from, to, outputType(this.graph, node));
      path.classList.toggle("nd-wire-selected", edge === this.selectedEdge || edge === this.insertOn);
      path.classList.toggle("nd-wire-muted", this.wireDrag?.detached.includes(edge) ?? false);
      const hit = path.cloneNode() as SVGPathElement;
      hit.classList.add("nd-wire-hit");
      hit.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        this.viewport.focus();
        this.selectNode();
        this.selectedEdge = edge;
        this.drawWires();
      });
      hit.addEventListener("contextmenu", event => {
        event.preventDefault(); event.stopPropagation();
        const pos = this.local(event.clientX, event.clientY);
        this.showMenu(pos, [button("Disconnect", () => { this.closeMenu(); this.removeEdge(edge); })]);
      });
      this.wires.append(path, hit);
      this.edgePaths.push({ edge, path: hit });
    }
    if (this.wireDrag) {
      const { ports, point } = this.wireDrag;
      for (const port of ports) {
        const fixed = this.portPosition(port);
        const node = this.graph.nodes.find(item => item.id === port.node);
        if (!fixed || !node) continue;
        const type = port.input ? inputsFor(this.graph, node).find(item => item.id === port.input)?.type : outputType(this.graph, node);
        const path = port.input ? this.wirePath(point, fixed, type) : this.wirePath(fixed, point, type);
        path.classList.add("nd-wire-drag");
        this.wires.append(path);
      }
    }
  }

  private selectNode(id?: string) {
    this.selected = id;
    this.selectedEdge = undefined;
    for (const [key, card] of this.cards) card.classList.toggle("is-selected", key === id);
  }

  private track(start: PointerEvent, move: (event: PointerEvent) => void, finish: (event?: PointerEvent) => void) {
    this.cancelDrag?.();
    const controller = new AbortController();
    const { signal } = controller;
    const end = (event?: PointerEvent) => {
      controller.abort();
      this.cancelDrag = undefined;
      finish(event);
    };
    this.cancelDrag = () => end();
    document.addEventListener("pointermove", event => { if (event.pointerId === start.pointerId) move(event); }, { signal });
    document.addEventListener("pointerup", event => { if (event.pointerId === start.pointerId) end(event); }, { signal });
    document.addEventListener("pointercancel", event => { if (event.pointerId === start.pointerId) end(); }, { signal });
    window.addEventListener("blur", () => end(), { signal });
  }

  private startPan(event: PointerEvent) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 0 && (event.target as Element).closest(".nd-node, .nd-wire-hit, .nd-menu, .nd-variables, .nd-navigation")) return;
    event.preventDefault();
    this.viewport.focus();
    this.closeMenu();
    this.variables.hidden = true;
    this.selectNode();
    const origin = { x: this.view.x, y: this.view.y };
    this.track(event, move => {
      this.view.x = origin.x + move.clientX - event.clientX;
      this.view.y = origin.y + move.clientY - event.clientY;
      this.transform();
    }, end => {
      if (!end) Object.assign(this.view, origin);
      this.transform();
      this.save();
    });
  }

  private startNodeMove(event: PointerEvent, node: GraphNode) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    event.preventDefault();
    this.viewport.focus();
    this.closeMenu();
    const card = this.cards.get(node.id);
    if (!card) return;
    this.selectNode(node.id);
    this.drawWires();
    let x = node.x, y = node.y;
    const moveNode = (move: PointerEvent) => {
      x = node.x + (move.clientX - event.clientX) / this.view.zoom;
      y = node.y + (move.clientY - event.clientY) / this.view.zoom;
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      const point = this.local(move.clientX, move.clientY);
      this.insertOn = this.edgePaths.find(({ edge, path }) => path.isPointInStroke(new DOMPoint(point.x, point.y)) && this.insertGraph(node, edge))?.edge;
      this.drawWires();
    };
    this.track(event, moveNode, end => {
      const edge = this.insertOn;
      this.insertOn = undefined;
      if (!end || (x === node.x && y === node.y)) { this.render(); return; }
      const next = edge ? this.insertGraph(node, edge) ?? this.graph : this.graph;
      this.change({ ...next, nodes: next.nodes.map(item => item.id === node.id ? { ...item, x, y } : item) });
    });
  }

  private insertGraph(node: GraphNode, target: GraphEdge): Graph | undefined {
    const input = inputsFor(this.graph, node)[0];
    if (!input || target.from === node.id || target.to === node.id || this.graph.edges.some(edge => edge.to === node.id && edge.input === input.id)) return;
    const graph = withEdge({ ...this.graph, edges: this.graph.edges.filter(edge => edge !== target) }, { from: target.from, to: node.id, input: input.id });
    if (graph) return withEdge(graph, { ...target, from: node.id });
  }

  private startWire(event: PointerEvent, port: Port) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelDrag?.();
    this.viewport.focus();
    this.closeMenu();
    this.selectNode(port.node);
    const graph = this.graph;
    const detached = this.edgesAt(port);
    const base = detached.length ? { ...graph, edges: graph.edges.filter(edge => !detached.includes(edge)) } : graph;
    if (event.altKey) {
      if (base !== graph) this.change(base);
      else this.drawWires();
      return;
    }
    const fixedPorts = detached.length
      ? detached.map(edge => port.input ? { node: edge.from } : { node: edge.to, input: edge.input })
      : [port];
    const resolveDrop = (target: Port) => {
      if (!detached.length || (!port.input && target.input)) return this.connect(graph, port, target);
      if (target.node === port.node && target.input === port.input) return graph;
      return fixedPorts.reduce<Graph | undefined>((next, fixed) => next && this.connect(next, fixed, target), base);
    };
    this.wireDrag = { ports: fixedPorts, point: this.local(event.clientX, event.clientY), detached };
    this.highlight(socket => Boolean(resolveDrop(socket)));
    this.drawWires();
    this.track(event, move => {
      const target = this.portFrom(document.elementFromPoint(move.clientX, move.clientY));
      const addingBranch = detached.length > 0 && !port.input && target?.input && Boolean(resolveDrop(target));
      this.wireDrag = {
        ports: addingBranch ? [port] : fixedPorts,
        point: this.local(move.clientX, move.clientY),
        detached: addingBranch ? [] : detached,
      };
      this.drawWires();
    }, end => {
      this.wireDrag = undefined;
      this.highlight(() => false);
      this.drawWires();
      if (!end || this.graph !== graph || Math.hypot(end.clientX - event.clientX, end.clientY - event.clientY) < 5) return;
      const under = document.elementFromPoint(end.clientX, end.clientY);
      const target = this.portFrom(under);
      if (!target && under && this.viewport.contains(under) && !under.closest(".nd-node,.nd-wire-hit,.nd-navigation,.nd-menu,.nd-variables")) {
        this.openMenu(this.local(end.clientX, end.clientY), port, detached.length ? { fixedPorts, detached } : undefined);
        return;
      }
      const next = (target && resolveDrop(target)) ?? base;
      if (next !== graph) this.change(next);
    });
  }

  private edgesAt(port: Port) {
    return this.graph.edges.filter(edge => port.input
      ? edge.to === port.node && edge.input === port.input
      : edge.from === port.node);
  }

  private connect(graph: Graph, first: Port, second: Port): Graph | undefined {
    const [from, to] = first.input ? [second, first] : [first, second];
    if (from.input || !to.input) return;
    if (graph.edges.some(edge => edge.from === from.node && edge.to === to.node && edge.input === to.input)) return graph;
    return withEdge(graph, { from: from.node, to: to.node, input: to.input });
  }

  private highlight(matches: (port: Port) => boolean) {
    for (const port of this.world.querySelectorAll<HTMLElement>("[data-port]")) port.classList.toggle("nd-port-compatible", matches(this.portFrom(port)!));
  }

  private portFrom(under: Element | null): Port | undefined {
    const port = under?.closest<HTMLElement>("[data-port]");
    if (port?.dataset.port && this.world.contains(port)) return { node: port.dataset.port, input: port.dataset.input || undefined };
  }

  private receive(drop: NodeDrop | null, x: number, y: number, commit: boolean): boolean {
    this.ghost.hidden = true;
    this.highlight(() => false);
    if (!drop || !this.visible) return false;
    const under = document.elementFromPoint(x, y);
    if (!under || !this.viewport.contains(under) || under.closest(".nd-menu,.nd-variables,.nd-navigation")) return false;
    const local = this.local(x, y);
    const point = this.worldPoint(local);
    const target = this.portFrom(under);
    if (target) {
      // Leave room beside the target card for an automatically attached node.
      point.x += target.input ? -234 : 50;
      point.y -= 34;
      while (this.graph.nodes.some(item => Math.abs(item.x - point.x) < 190 && Math.abs(item.y - point.y) < 72)) point.y += 80;
    }
    const node: GraphNode = { id: "sidebar-drag", kind: drop.kind, x: point.x, y: point.y, data: drop.data ?? {} };
    const graph = { ...this.graph, nodes: [...this.graph.nodes, node] };
    const isFree = (port: Port) => !port.input || !graph.edges.some(edge => edge.to === port.node && edge.input === port.input);
    const proposed = target && isFree(target) ? this.attach(graph, node, target) : undefined;
    const canPlace = target ? Boolean(proposed) : !under.closest(".nd-node,.nd-wire-hit");
    if (commit) {
      if (canPlace) this.addAt(drop, point, target ? (graph, node) => this.attach(graph, node, target) : undefined);
    } else {
      this.highlight(port => isFree(port) && Boolean(this.attach(graph, node, port)));
      const item = definition(drop.kind);
      this.ghost.dataset.category = item.category;
      this.ghost.textContent = item.label;
      this.ghost.classList.toggle("blocked", !canPlace);
      this.ghost.style.left = `${local.x + 10}px`;
      this.ghost.style.top = `${local.y + 10}px`;
      this.ghost.hidden = false;
    }
    return true;
  }

  addMedia(id: string) {
    const point = this.worldPoint({ x: this.viewport.clientWidth * 0.35, y: this.viewport.clientHeight * 0.35 });
    this.addAt({ kind: "media", data: { media: id } }, point);
  }

  private attach(graph: Graph, node: GraphNode, port: Port): Graph | undefined {
    if (port.input) return this.connect(graph, { node: node.id }, port);
    for (const socket of inputsFor(graph, node)) {
      const next = this.connect(graph, port, { node: node.id, input: socket.id });
      if (next) return next;
    }
  }

  private addAt(drop: NodeDrop, point: Point, attach?: AttachNode) {
    const node = makeNode(drop.kind, point.x, point.y, drop.data);
    const graph = { ...this.graph, nodes: [...this.graph.nodes, node] };
    const next = attach ? attach(graph, node) : graph;
    if (!next) return false;
    this.selected = node.id;
    this.selectedEdge = undefined;
    this.change(next);
    this.viewport.focus();
    return true;
  }

  private openMenu(point: Point, port?: Port, cable?: PendingCable) {
    this.closeMenu();
    this.variables.hidden = true;
    const position = this.worldPoint(point);
    const base = this.graph;
    const attach: AttachNode | undefined = port && ((graph, node) => {
      if (!cable) return this.attach(graph, node, port);
      const loose = { ...graph, edges: graph.edges.filter(edge => !cable.detached.includes(edge)) };
      const connected = cable.fixedPorts.reduce<Graph | undefined>((next, fixed) => next && this.attach(next, node, fixed), loose);
      return connected && (this.attach(connected, node, port) ?? connected);
    });
    const choices: MenuChoice[] = [];
    for (const kind of nodeKinds) {
      const def = definition(kind);
      const options = kind === "get" || kind === "set"
        ? base.variables.filter(variable => kind === "get" || !base.nodes.some(node => node.kind === "set" && node.data.variable === variable.id))
          .map(variable => ({ name: `${kind === "get" ? "Get" : "Set"} ${variable.name}`, data: { variable: variable.id } }))
        : [{ name: def.label, data: undefined }];
      for (const option of options) {
        const node: GraphNode = { id: "menu-node", kind, ...position, data: option.data ?? {} };
        const compatible = (candidate: GraphNode) => !attach || Boolean(attach({ ...base, nodes: [...base.nodes, candidate] }, candidate));
        const modes = def.modes?.filter(mode => compatible({ ...node, data: { ...node.data, mode: mode.id } }));
        if (modes ? modes.length === 0 : !compatible(node)) continue;
        choices.push({
          drop: { kind, data: option.data }, name: option.name, category: def.category, modes,
          search: [option.name, kind, ...(def.reference ?? [])],
        });
      }
    }
    const { browser, search } = createNodeMenu(choices, drop => {
      if (this.addAt(drop, position, attach)) this.closeMenu(false);
    });
    this.showMenu(point, [browser], cable && (() => this.disconnectEdges(cable.detached)), true);
    search.focus();
  }

  private showMenu(point: Point, children: HTMLElement[], dismiss?: () => void, catalog = false) {
    this.closeMenu();
    this.dismissMenu = dismiss;
    this.menu.replaceChildren(...children);
    this.menu.classList.toggle("nd-catalog-menu", catalog);
    const panelHeight = Math.min(420, Math.max(0, this.viewport.clientHeight - 8));
    this.menu.style.setProperty("--nd-menu-height", `${panelHeight}px`);
    this.menu.hidden = false;
    const height = catalog ? panelHeight : this.menu.offsetHeight;
    this.menu.style.left = `${Math.max(4, Math.min(point.x, this.viewport.clientWidth - this.menu.offsetWidth - 4))}px`;
    this.menu.style.top = `${Math.max(4, Math.min(point.y, this.viewport.clientHeight - height - 4))}px`;
  }

  private closeMenu(dismiss = true) {
    const action = this.dismissMenu;
    this.dismissMenu = undefined;
    this.menu.hidden = true;
    if (dismiss) action?.();
  }

  private openActions(node: GraphNode, point: Point) {
    this.closeMenu();
    this.selectNode(node.id);
    const choices = [button("Delete node", () => { this.closeMenu(); this.removeNode(node.id); }, "nd-menu-item")];
    const input = this.graph.edges.find(edge => edge.to === node.id && edge.input === inputsFor(this.graph, node)[0]?.id);
    const outgoing = this.graph.edges.filter(edge => edge.from === node.id);
    if (input && outgoing.length) {
      const base = { ...this.graph, edges: this.graph.edges.filter(edge => edge !== input && edge.from !== node.id) };
      let next: Graph | undefined = base;
      for (const edge of outgoing) next = next && withEdge(next, { ...edge, from: input.from });
      if (next) {
        const graph = next;
        choices.unshift(button("Detach from chain", () => { this.closeMenu(); this.change(graph); }, "nd-menu-item"));
      }
    }
    this.showMenu(point, choices);
  }

  private removeNode(id: string) {
    this.view.previews = this.view.previews.filter(item => item !== id);
    this.selectNode();
    this.change({ ...this.graph, nodes: this.graph.nodes.filter(node => node.id !== id), edges: this.graph.edges.filter(edge => edge.from !== id && edge.to !== id) });
  }

  private removeEdge(edge: GraphEdge) {
    this.disconnectEdges([edge]);
  }

  private disconnectEdges(detached: GraphEdge[]) {
    const edges = this.graph.edges.filter(edge => !detached.includes(edge));
    if (edges.length === this.graph.edges.length) return;
    if (this.selectedEdge && detached.includes(this.selectedEdge)) this.selectedEdge = undefined;
    this.change({ ...this.graph, edges });
  }

  private toggleVariables() {
    this.closeMenu();
    this.variables.hidden = !this.variables.hidden;
    if (!this.variables.hidden) this.renderVariables();
  }

  private renderVariables() {
    const heading = element("strong", "", "Variables");
    const input = element("input", "nd-field");
    input.placeholder = "Name";
    input.setAttribute("aria-label", "Variable name");
    const kinds = select(valueTypes.map(type => [type, typeLabels[type]]), "number", "Variable type", () => {});
    const add = () => {
      const name = input.value.trim();
      if (!name || this.graph.variables.some(variable => variable.name === name)) return;
      this.change({ ...this.graph, variables: [...this.graph.variables, { id: crypto.randomUUID(), name, type: kinds.value as ValueType }] });
    };
    input.addEventListener("keydown", event => { if (event.key === "Enter") add(); });
    this.variables.replaceChildren(heading);
    for (const variable of this.graph.variables) {
      const line = element("div", "nd-variable-row");
      const rename = element("input", "nd-field");
      rename.value = variable.name;
      rename.setAttribute("aria-label", "Rename variable");
      rename.addEventListener("change", () => {
        const name = rename.value.trim();
        if (!name || this.graph.variables.some(item => item.id !== variable.id && item.name === name)) { rename.value = variable.name; return; }
        this.change({ ...this.graph, variables: this.graph.variables.map(item => item.id === variable.id ? { ...item, name } : item) });
      });
      const type = element("span", "", typeLabels[variable.type]);
      type.dataset.type = variable.type;
      line.append(rename, type);
      this.variables.append(line);
    }
    const create = element("div", "nd-variable-row");
    create.append(input, kinds, button("Add", add));
    this.variables.append(create);
  }

  private keydown(event: KeyboardEvent) {
    if (!this.visible) return;
    const target = event.target as Element;
    if (event.key === "Escape") {
      this.cancelDrag?.();
      if (!this.menu.hidden) {
        this.closeMenu();
        this.viewport.focus();
      }
      this.variables.hidden = true;
      this.receive(null, 0, 0, false);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (target.matches("input,select")) (target as HTMLElement).blur();
      this.run();
    }
    if (target.closest("input,select,textarea") || !this.host.contains(target)) return;
    if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      if (event.shiftKey || event.key.toLowerCase() === "y") this.redo(); else this.undo();
    }
    if (event.key === "Delete") {
      if (this.selectedEdge) this.removeEdge(this.selectedEdge);
      else if (this.selected) this.removeNode(this.selected);
    }
  }
}
