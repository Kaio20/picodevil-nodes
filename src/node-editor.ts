import {
  cableInput, cableType, definition, fftBands, fontAxes, fontAxisFor, hasConnectedInput, inputType, inputsFor, insertNodeOnEdge, isCablePoint, isPixelOutput, isRenderable, isVariableSetter, keepCompatibleEdges, makeNode, MIN_GRAPH_ZOOM, modeFor, nodeKinds, outputsFor, outputType,
  previewType, pruneRoutingNodes, rampInterpolation, rampStops, valueTypes, withConvertedEdge, withEdge, type Graph, type GraphEdge, type GraphNode,
  type Literal, type NodeDrop, type NodeMode, type ValueType,
} from "./node-graph";
import type { PreviewTarget } from "./node-runtime";
import { setSidebarDropReceiver, type SidebarDropOptions } from "./node-sidebar-drag";
import { getAllEntries, isTexture, type MediaEntry } from "./media-registry";
import { catalogTexture, getTexturePacks, useCatalogTexture } from "./texture-library";
import { FONT_AXES } from "./font-list";
import { referenceForNode, type RefEntry } from "./reference";
import { setupNodeTooltip } from "./node-tooltip";
import { bindNumberDrag, trackPointerDrag } from "./node-number-input";
import { gradientField } from "./node-gradient-input";
import { clampUnit, colorFromCss, isColorValue } from "./color-value";
import { colorField } from "./node-color-input";
import { blendModes } from "./renderer-interface";
import { nodeChoiceField, type SelectChoice } from "./node-choice-field";
import { phosphorIcon } from "./icons";

export interface GraphView { x: number; y: number; zoom: number; previews: string[] }
interface Options {
  graph: Graph;
  view: GraphView;
  save(graph: Graph, view: GraphView): void;
  run(graph: Graph, restart: boolean): string | null;
  showCode(): void;
  openReference(entry: RefEntry): void;
  openOutput(): void;
  bindProjectionToggle(button: HTMLButtonElement): void;
}
interface Point { x: number; y: number }
interface Port { node: string; input?: string; output?: string }
interface PendingCable { fixedPorts: Port[]; detached: GraphEdge[] }
interface Insertion { edge: GraphEdge; spliced: boolean; input?: string; output?: string; atPort?: boolean; padded?: boolean }
type AttachNode = (graph: Graph, node: GraphNode) => Graph | undefined;
interface MenuChoice { drop: NodeDrop; name: string; category: string; modes?: NodeMode[]; defaultMode?: NodeMode; search: string[] }
const svgNamespace = "http://www.w3.org/2000/svg";
const portDropPadding = 10;
const alignedNodeGap = 24;
const typeLabels: Record<ValueType, string> = { visual: "Image", textLayer: "Text", number: "Float", text: "String", boolean: "Boolean", color: "Color" };
const categoryIcons: Record<string, string> = {
  Sources: "film-strip", Signals: "waveform", Expressions: "function", Playback: "play",
  Layout: "grid-four", Image: "image", Text: "text-t", Variables: "brackets-curly",
  Output: "monitor", Routing: "path",
};
const blendMenuModes: NodeMode[] = blendModes.map(id => ({
  id, label: id.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" "),
}));

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

function iconButton(icon: string, label: string, action: () => void, className = "nd-button") {
  const el = button("", action, className);
  el.append(phosphorIcon(icon));
  el.setAttribute("aria-label", label);
  return el;
}

const fontAxisChoices: SelectChoice[] = fontAxes.map(({ tag, label }) => {
  if (tag === "italic") return [tag, label, "Switch between italic and upright."];
  const sample = Object.entries(FONT_AXES).find(([, axes]) => axes.some(axis => axis.tag === tag))?.[0];
  const hint = tag === "slnt" ? "0° is upright. Negative values lean right."
    : sample ? `Use a font like ${sample}.` : "Requires a font with this axis.";
  return [tag, label, `OpenType axis: ${tag}\n${hint}`];
});

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
  const hoverDelay = 160;
  const hoverTolerance = 5;
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
  let hover: { point: Point; timer: number } | undefined;
  const tabs = new Map<string, HTMLButtonElement>();
  function cancelHover() {
    if (!hover) return;
    window.clearTimeout(hover.timer);
    hover = undefined;
  }
  function show(category?: string) {
    cancelHover();
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
        name: mode && (matchingMode || mode !== choice.defaultMode) ? `${choice.name} · ${mode.label}` : choice.name,
        drop: mode ? { ...choice.drop, data: { ...choice.drop.data, mode: mode.id } } : choice.drop,
        category: choice.category, score,
      }];
    });
    if (query.length) matches.sort((a, b) => b.score - a.score);
    for (const item of matches) {
      const row = button(item.name, () => choose(item.drop), "nd-menu-item");
      row.dataset.category = item.category;
      row.dataset.tooltip = item.name;
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
    tab.prepend(phosphorIcon(categoryIcons[category], "nd-menu-icon"));
    const arrow = phosphorIcon("caret-right", "nd-menu-arrow");
    tab.append(arrow);
    const trackHover = (event: PointerEvent) => {
      if (query.length || event.buttons !== 0 || event.pointerType === "touch" || category === active || event.target === arrow) {
        cancelHover();
        return;
      }
      const { left, width } = tab.getBoundingClientRect();
      if (event.clientX < left + width * 0.75) {
        show(category);
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      if (hover && Math.hypot(point.x - hover.point.x, point.y - hover.point.y) <= hoverTolerance) return;
      cancelHover();
      hover = { point, timer: window.setTimeout(() => {
        hover = undefined;
        if (tab.isConnected && tab.matches(":hover") && !arrow.matches(":hover")) show(category);
      }, hoverDelay) };
    };
    tab.addEventListener("pointermove", trackHover);
    arrow.addEventListener("pointerenter", cancelHover);
    tab.addEventListener("pointerleave", cancelHover);
    tab.addEventListener("pointerdown", cancelHover);
    tab.addEventListener("pointercancel", cancelHover);
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
  private graph: Graph;
  readonly view: GraphView;
  private past: Graph[] = [];
  private future: Graph[] = [];
  private selected = new Set<string>();
  private selectedEdge?: GraphEdge;
  private nodeZIndices = new Map<string, number>();
  private lastNodeZIndex = 0;
  private viewport = element("div", "nd-viewport");
  private world = element("div", "nd-world");
  private wires = document.createElementNS(svgNamespace, "svg");
  private selectionBox = element("div", "nd-selection-box");
  private menu = element("div", "nd-menu");
  private menuAnchor?: Point;
  private dismissMenu?: () => void;
  private variables = element("div", "nd-variables");
  private ghost = element("div", "nd-drop-ghost");
  private insertHint = button("", () => this.commitInsertion(), "nd-button nd-insert-hint");
  private status = element("span", "nd-status");
  private undoButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private zoomLabel = element("span", "nd-zoom", "100%");
  private previews: PreviewTarget[] = [];
  private choicePreview?: { graph: Graph; id: string; original?: PreviewTarget; alternate?: PreviewTarget };
  private sourcePickers = new Map<string, ReturnType<typeof nodeChoiceField<string>>>();
  private cards = new Map<string, HTMLElement>();
  private edgePaths: { edge: GraphEdge; path: SVGPathElement; hit: SVGPathElement; insertHit: SVGPathElement }[] = [];
  private wireDrag?: { ports: Port[]; point: Point; detached: GraphEdge[] };
  private cancelDrag?: () => void;
  private insertion?: Insertion & { point: Point };
  private applied?: Graph;
  private mediaSignature = "";
  private dismissTooltip: () => void;

  constructor(private host: HTMLElement, private options: Options) {
    this.graph = options.graph;
    this.view = options.view;
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute("aria-label", "Node graph");
    this.wires.classList.add("nd-wires");
    this.selectionBox.hidden = true;
    this.selectionBox.setAttribute("aria-hidden", "true");
    this.menu.hidden = this.variables.hidden = this.ghost.hidden = this.insertHint.hidden = true;
    this.status.setAttribute("role", "status");
    const top = element("div", "nd-toolbar");
    const brand = element("strong", "nd-brand", "NodesDevil");
    const add = button("Add Node", () => this.openMenu({ x: 26, y: 22 }));
    add.prepend(phosphorIcon("plus"), " ");
    this.undoButton = iconButton("arrow-u-up-left", "Undo", () => this.undo());
    this.undoButton.dataset.tooltip = "Undo";
    this.redoButton = iconButton("arrow-u-up-right", "Redo", () => this.redo());
    this.redoButton.dataset.tooltip = "Redo";
    const projection = element("button", "nd-button", "Projection");
    projection.type = "button";
    projection.prepend(phosphorIcon("projector-screen"), " ");
    options.bindProjectionToggle(projection);
    const output = button("Open Output", options.openOutput);
    output.prepend(phosphorIcon("paper-plane-tilt"), " ");
    const playback = element("div", "nd-playback-controls");
    playback.append(projection, this.makeRunButton(), this.status);
    top.append(brand, add, button("Variables", () => this.toggleVariables()), this.undoButton, this.redoButton,
      playback, output);
    const navigation = element("div", "nd-navigation");
    const compositor = element("a", "nd-button", "Compositor");
    compositor.href = import.meta.env.BASE_URL + "compositor/";
    navigation.append(iconButton("minus", "Zoom out", () => this.centerZoom(1 / 1.2)), this.zoomLabel,
      iconButton("plus", "Zoom in", () => this.centerZoom(1.2)), button("Frame All", () => this.fit()),
      button("Code", options.showCode), compositor);
    this.viewport.append(this.wires, this.world, this.selectionBox, this.ghost, this.insertHint, navigation, this.menu, this.variables);
    host.append(top, this.viewport);
    this.dismissTooltip = setupNodeTooltip(host);
    this.viewport.addEventListener("pointerdown", event => this.startCanvasGesture(event));
    this.insertHint.addEventListener("pointerdown", event => event.stopPropagation());
    this.viewport.addEventListener("pointermove", event => this.hoverInsertion(event));
    this.viewport.addEventListener("pointerleave", () => {
      if (!this.cancelDrag) this.showInsertion();
    });
    this.viewport.addEventListener("contextmenu", event => {
      if ((event.target as Element).closest(".nd-node, .nd-menu, .nd-variables, .nd-navigation")) return;
      event.preventDefault();
      this.openMenu(this.local(event.clientX, event.clientY));
    });
    this.viewport.addEventListener("wheel", event => {
      if ((event.target as Element).closest(".nd-menu, .nd-variables, .nd-color-popover, .nd-choice-field, input, select")) return;
      this.world.querySelector<HTMLElement>(".nd-color-popover:popover-open")?.hidePopover();
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
    new ResizeObserver(() => {
      this.drawWires();
      this.positionMenu();
    }).observe(this.viewport);
    setSidebarDropReceiver((drop, x, y, commit, options) => this.receive(drop, x, y, commit, options));
    this.render();
  }

  get visible() { return !this.host.hidden; }
  get previewGraph() { return this.choicePreview?.graph ?? this.graph; }
  get previewNode() { return this.choicePreview?.id; }

  visiblePreviews(): PreviewTarget[] {
    if (!this.visible || document.hidden) return [];
    const viewport = this.viewport.getBoundingClientRect();
    const { original, alternate } = this.choicePreview ?? {};
    return this.previews.map(target => target === original && alternate ? alternate : target).filter(({ element }) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
    });
  }

  mediaChanged() {
    const entries = getAllEntries();
    const sources = entries.map(({ id, name, url, type, collection, unavailable }) => [id, name, url, type, collection, unavailable]);
    const signature = JSON.stringify([getTexturePacks().length, sources]);
    if (this.mediaSignature === signature) return;
    this.mediaSignature = signature;
    this.dismissTooltip();
    this.graph = { ...this.graph };
    for (const node of this.graph.nodes) {
      const card = this.cards.get(node.id);
      if ((node.kind === "media" || node.kind === "texture") && card) this.updateMediaCard(card, node, entries);
    }
  }

  refresh() { this.render(); }

  loadExample(graph: Graph) {
    this.closeMenu();
    this.variables.hidden = true;
    this.selectNodes();
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

  private makeRunButton() {
    const run = button("Run", () => this.run(), "nd-button nd-run");
    run.prepend(phosphorIcon("play"), " ");
    run.dataset.tooltip = "Run graph\nCtrl/Cmd+Enter";
    return run;
  }

  private change(graph: Graph) {
    this.past.push(this.graph);
    if (this.past.length > 75) this.past.shift();
    this.future.length = 0;
    this.graph = pruneRoutingNodes(graph);
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
    for (const run of this.host.querySelectorAll(".nd-run")) {
      run.classList.toggle("pending", this.applied !== this.graph);
    }
  }

  private save() { this.options.save(this.graph, this.view); }

  private render() {
    this.clearChoicePreview();
    this.dismissTooltip();
    const existing = new Map(this.previews.filter(target => !target.showRamp).map(target => [target.id, target]));
    this.previews = [];
    this.world.replaceChildren();
    this.cards.clear();
    this.sourcePickers.clear();
    for (const node of this.graph.nodes) this.renderNode(node, existing.get(node.id));
    for (const id of this.selected) {
      if (!this.cards.has(id)) this.selected.delete(id);
    }
    if (this.selectedEdge && !this.graph.edges.includes(this.selectedEdge)) this.selectedEdge = undefined;
    this.transform();
    this.refreshHistory();
    if (!this.variables.hidden) this.renderVariables();
  }

  private renderNode(node: GraphNode, previous?: PreviewTarget) {
    const def = definition(node.kind);
    const variableSetter = isVariableSetter(this.graph, node);
    const label = node.kind === "variable" ? (variableSetter ? "Set Variable" : "Get Variable") : def.label;
    const card = element("article", "nd-node");
    card.dataset.nodeId = node.id;
    card.dataset.kind = node.kind;
    card.dataset.category = def.category;
    card.classList.toggle("is-selected", this.selected.has(node.id));
    const zIndex = this.nodeZIndices.get(node.id);
    if (zIndex !== undefined) card.style.zIndex = String(zIndex);
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    if (isCablePoint(node) || node.kind === "convert") {
      const input = inputsFor(this.graph, node)[0];
      const output = outputType(this.graph, node);
      const converter = node.kind === "convert";
      const wiredInput = input && inputType(this.graph, node, input.id);
      const conversion = converter && wiredInput && output ? modeFor(node) : undefined;
      card.classList.add("nd-cable-point");
      const type = cableType(node);
      if (type) card.dataset.type = type;
      const handle = button("", () => {}, "nd-cable-handle");
      const loose = node.kind === "cableEnd";
      if (converter) {
        const icon = phosphorIcon("bandaids");
        if (wiredInput) handle.dataset.type = wiredInput;
        if (output) icon.dataset.type = output;
        handle.append(icon);
      }
      const name = conversion?.label ?? (loose ? `Loose ${node.data.side === "source" ? "output" : "input"} end`
        : converter && wiredInput ? `${input.label} Conversion` : converter && output ? `Conversion to ${typeLabels[output]}` : def.label);
      handle.setAttribute("aria-label", name);
      handle.dataset.tooltip = [name, conversion?.help, loose ? "Drag to move or reconnect" : "Drag to move"].filter(Boolean).join("\n");
      handle.addEventListener("focus", () => this.selectNode(node.id));
      handle.addEventListener("pointerdown", event => this.startNodeMove(event, node));
      card.append(handle);
      if (!loose && input) card.append(this.port(node, wiredInput, { input: input.id }));
      if (!loose && (converter || output)) card.append(this.port(node, output, {}));
      card.addEventListener("contextmenu", event => {
        event.preventDefault();
        this.openActions(node, this.local(event.clientX, event.clientY));
      });
      this.world.append(card);
      this.cards.set(node.id, card);
      return;
    }
    const header = element("header", "nd-node-head");
    const hasSourcePicker = node.kind === "media" || node.kind === "texture";
    const entries = hasSourcePicker ? getAllEntries() : [];
    const activeMode = modeFor(node);
    const { entry, summary } = referenceForNode(node.kind, activeMode);
    const title = entry
      ? button(label, () => this.options.openReference(entry), "nd-node-title")
      : element("span", "nd-node-title", label);
    if (entry) title.setAttribute("aria-label", `${label} reference`);
    title.dataset.tooltip = [activeMode ? `${label} · ${activeMode.label}` : label, summary, entry && "Open Reference"].filter(Boolean).join("\n");
    header.append(title);
    header.addEventListener("pointerdown", event => this.startNodeMove(event, node));
    const type = previewType(this.graph, node);
    if (type) {
      const open = this.view.previews.includes(node.id);
      const toggle = iconButton(open ? "caret-down" : "caret-right", `Preview ${label}`, () => {
        this.view.previews = open ? this.view.previews.filter(id => id !== node.id) : [...this.view.previews, node.id];
        this.save();
        this.render();
        this.cards.get(node.id)?.querySelector<HTMLButtonElement>(".nd-preview-toggle")?.focus();
      }, "nd-preview-toggle");
      toggle.setAttribute("aria-expanded", String(open));
      header.append(toggle);
    }
    card.append(header);
    const body = element("div", "nd-node-body");
    if (def.modes) {
      const setting = element("div", "nd-node-mode", "Mode");
      const choices: SelectChoice[] = def.modes.map(item => [
        item.id, item.label, referenceForNode(node.kind, item).summary, undefined,
        node.kind === "constant" ? item.inputs?.[0]?.type : item.output,
      ]);
      const mode = this.choiceField(node, "mode", choices, activeMode?.id ?? "", "Mode", value => {
        this.setData(node, "mode", value);
        this.cards.get(node.id)?.querySelector<HTMLElement>(".nd-node-mode .nd-choice-trigger")?.focus();
      }, true);
      setting.append(mode);
      body.append(setting);
    }
    if (hasSourcePicker) {
      const picker = nodeChoiceField([], "", def.label, (value: string) => {
        const texture = node.kind === "texture" ? catalogTexture(value) : undefined;
        this.setData(node, "media", texture ? useCatalogTexture(texture).id : value);
        this.cards.get(node.id)?.querySelector<HTMLElement>(".nd-choice-trigger")?.focus();
      }, value => this.previewData(node.id, "media", value));
      this.sourcePickers.set(node.id, picker);
      body.append(picker.field);
      body.append(element("small", "nd-node-error", `${def.label} unavailable`));
    }
    if (node.kind === "fft") {
      const bandLabels = ["Volume", "Bass", "Mid", "Treble"];
      const bandDescriptions = ["Overall audio level.", "Energy in the lowest frequency band.", "Energy in the middle frequency band.", "Energy in the highest frequency band."];
      const band = fftBands.find(band => band === node.data.band) ?? "bass";
      body.append(this.choiceField(node, "band", fftBands.map((band, index) => [band, bandLabels[index], bandDescriptions[index]]),
        band, "FFT band", value => this.setData(node, "band", value)));
    }
    if (node.kind === "variable") {
      const choices = this.graph.variables.filter(variable => !variableSetter || !this.graph.nodes.some(other =>
        other !== node && other.data.variable === variable.id && isVariableSetter(this.graph, other)));
      const options: SelectChoice[] = choices.map(item => [item.id, item.name, typeLabels[item.type], undefined, item.type]);
      body.append(this.choiceField(node, "variable", [["", "Choose variable…"], ...options], String(node.data.variable ?? ""),
        "Variable", value => this.setData(node, "variable", value), true));
    }
    for (const output of outputsFor(this.graph, node)) {
      const row = element("div", "nd-port-row nd-port-out");
      row.dataset.type = output.type;
      const label = output.label ?? (isRenderable(output.type) || output.type === "color" ? typeLabels[output.type] : "Value");
      row.append(element("span", "", label), this.port(node, output.type, { output: output.id }, output.label));
      body.append(row);
    }
    const inputs = inputsFor(this.graph, node);
    let ramp: ReturnType<typeof gradientField> | undefined;
    if (node.kind === "colorRamp") {
      card.classList.add("nd-gradient-node");
      const colors = new Map(inputs.flatMap(socket => {
        if (socket.type !== "color" || !isColorValue(socket.default)) return [];
        const color = node.data[socket.id];
        return [[socket.id, isColorValue(color) ? color : socket.default] as const];
      }));
      ramp = gradientField(rampStops(node), colors, rampInterpolation(node), (stops, active, added) => {
        const current = this.graph.nodes.find(item => item.id === node.id);
        if (!current) return;
        const data: GraphNode["data"] = { ...current.data, stops };
        const removed = rampStops(current).find(stop => !stops.some(next => next.id === stop.id));
        if (removed) delete data[removed.id];
        if (added) data[active] = added;
        this.change({
          ...this.graph,
          nodes: this.graph.nodes.map(item => item === current ? { ...item, data } : item),
          edges: removed ? this.graph.edges.filter(edge => edge.to !== node.id || edge.input !== removed.id) : this.graph.edges,
        });
        this.cards.get(node.id)?.querySelector<HTMLButtonElement>(`[data-ramp-stop="${active}"]`)?.focus();
      }, value => this.editLiteral(node.id, "interpolation", value, true), value => this.previewData(node.id, "interpolation", value));
      body.append(ramp.field);
      const wired = new Set([...colors.keys()].filter(input => hasConnectedInput(this.graph, node.id, input)));
      if (wired.size) {
        const status = element("span", "nd-preview-status");
        ramp.field.append(status);
        const showRamp = ramp.showGradient;
        this.previews.push({ id: node.id, element: ramp.field, status, samples: [], showRamp: value => showRamp(wired, value) });
      }
    }
    for (const socket of inputs) {
      const fontAxis = node.kind === "fontAxis" && socket.id === "tag";
      const row = element(fontAxis || socket.type === "color" ? "div" : "label", "nd-port-row");
      row.dataset.type = socket.type;
      const connected = hasConnectedInput(this.graph, node.id, socket.id);
      row.classList.toggle("nd-connected", connected);
      if (!connected && node.kind !== "variable" && !socket.optional && socket.default === undefined) row.classList.add("nd-required");
      row.append(this.port(node, socket.type, { input: socket.id }), element("span", "", socket.label));
      if (!connected && socket.type === "color" && (socket.optional || socket.default !== undefined)) {
        const value = node.data[socket.id] ?? socket.default;
        const color = isColorValue(value) ? value : typeof value === "string" ? colorFromCss(value) : undefined;
        row.append(colorField(color, socket.label, value => {
          this.editLiteral(node.id, socket.id, value, true);
          if (value) ramp?.setColor(socket.id, value);
        }, socket.optional, value !== undefined));
      } else if (fontAxis && !connected) {
        row.append(this.fontAxisField(node, String(node.data.tag ?? socket.default)));
      } else if (!connected && socket.choices) {
        const value = String(node.data[socket.id] ?? socket.default ?? "");
        const choices = socket.choices.map<SelectChoice>(choice => [choice, choice]);
        // Keep values saved before this socket offered a dropdown.
        if (!socket.choices.includes(value)) choices.push([value, value || "(empty)"]);
        row.append(this.choiceField(node, socket.id, choices, value, socket.label, selected => this.editLiteral(node.id, socket.id, selected, true)));
      } else if (!connected && (socket.type === "number" || socket.type === "boolean" || socket.type === "text") &&
          (socket.optional || socket.default !== undefined)) {
        const input = element("input", "nd-field");
        input.type = socket.type === "boolean" ? "checkbox" : socket.type === "number" ? "number" : "text";
        input.step = "any";
        if (socket.unitInterval) {
          input.min = "0";
          input.max = "1";
          input.addEventListener("change", () => {
            if (input.validity.rangeUnderflow || input.validity.rangeOverflow) {
              input.value = String(clampUnit(input.valueAsNumber));
            }
          });
        }
        input.setAttribute("aria-label", socket.label);
        const literal = node.data[socket.id] ?? socket.default;
        input.value = String(socket.unitInterval && typeof literal === "number" ? clampUnit(literal) : literal ?? "");
        if (socket.optional) input.placeholder = node.kind === "scale" ? "Uniform" : node.kind === "grid" ? "Auto" : "—";
        input.checked = literal === true;
        let editing = false;
        input.addEventListener("blur", () => { editing = false; });
        input.addEventListener("input", () => {
          if (input.validity.badInput) return;
          const value = input.type === "checkbox" ? input.checked
            : socket.optional && input.value === "" ? undefined
            : input.type === "number" ? input.valueAsNumber : input.value;
          if (typeof value === "number" && !Number.isFinite(value)) return;
          const normalized = socket.unitInterval && typeof value === "number" ? clampUnit(value) : value;
          this.editLiteral(node.id, socket.id, normalized, !editing);
          editing = true;
        });
        if (input.type === "number") {
          bindNumberDrag(input, socket.dragStep, value => {
            this.editLiteral(node.id, socket.id, value, true);
            editing = false;
          }, (start, move, finish) => this.track(start, move, finish));
        }
        row.append(input);
      }
      if (fontAxis) body.prepend(row);
      else if (ramp && socket.id === "image") body.insertBefore(row, ramp.field);
      else body.append(row);
    }
    if (node.kind === "output") {
      const outputs = this.graph.nodes.filter(item => item.kind === "output");
      const order = outputs.findIndex(item => item.id === node.id);
      if (outputs.length > 1) {
        const { field } = nodeChoiceField(outputs.map((_, i) => [String(i), `Layer ${i + 1}`]),
          String(order), "Layer order", value => this.reorderOutput(node, Number(value)));
        body.append(field);
      }
      body.append(this.makeRunButton());
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
    if (hasSourcePicker) this.updateMediaCard(card, node, entries);
  }

  private fontAxisField(node: GraphNode, tag: string) {
    const field = element("div", "nd-font-axis-field");
    const axis = fontAxisFor(tag);
    const customDescription = (value: string) => value ? `OpenType axis: ${value}` : "Enter an OpenType axis tag.";
    const choices: SelectChoice[] = [...fontAxisChoices, ["", "Custom tag…", customDescription(axis ? "" : tag)]];
    const picker = this.choiceField(node, "tag", choices, axis?.tag ?? "", "Font axis", value => {
      this.setData(node, "tag", value);
      this.cards.get(node.id)?.querySelector<HTMLElement>(value ? ".nd-font-axis-field .nd-choice-trigger" : ".nd-font-axis-field input")?.focus();
    }, true);
    field.append(picker);
    if (!axis) {
      const custom = element("input", "nd-field");
      custom.setAttribute("aria-label", "Custom axis tag");
      custom.placeholder = "Axis tag";
      custom.value = tag;
      let editing = false;
      custom.addEventListener("blur", () => { editing = false; });
      custom.addEventListener("input", () => {
        const tag = custom.value.trim();
        this.editLiteral(node.id, "tag", tag, !editing);
        picker.querySelector<HTMLElement>(".nd-choice-trigger")!.dataset.tooltip = `Custom tag…\n${customDescription(tag)}`;
        editing = true;
      });
      field.append(custom);
    }
    return field;
  }

  private updateMediaCard(card: HTMLElement, node: GraphNode, entries: MediaEntry[]) {
    const texture = node.kind === "texture";
    const sources = texture ? entries.filter(isTexture) : entries;
    const media = sources.find(item => item.id === node.data.media);
    const picker = this.sourcePickers.get(node.id)!;
    if (texture) {
      this.updateTexturePicker(picker, sources, media);
    } else {
      const mediaTypes = { video: "Video", image: "Image", stream: "Live stream" };
      picker.setChoices([["", "Choose media…"], ...sources.map(({ id, name, type }): SelectChoice => [id, name, mediaTypes[type]])], media?.id ?? "");
    }
    card.querySelector(".nd-preview-toggle")?.setAttribute("aria-label", `Preview ${media?.name ?? definition(node.kind).label}`);
    card.querySelector<HTMLElement>(".nd-node-error")!.hidden = Boolean(media && !media.unavailable);
  }

  private updateTexturePicker(picker: ReturnType<typeof nodeChoiceField<string>>, entries: MediaEntry[], selected?: MediaEntry) {
    const registered = new Map<string, MediaEntry>();
    const local: MediaEntry[] = [];
    for (const entry of entries) {
      if (catalogTexture(entry.url) && !registered.has(entry.url)) registered.set(entry.url, entry);
      else local.push(entry);
    }
    const choices: SelectChoice[] = [["", "Choose texture…"], ...local.map(({ id, name }): SelectChoice => [id, name, undefined, "My textures"])];
    for (const pack of getTexturePacks()) {
      for (const texture of pack.textures) {
        const name = registered.get(texture.url)?.name;
        choices.push([texture.url, name && name !== texture.name ? name : texture.label, undefined, pack.label]);
      }
    }
    picker.setChoices(choices, selected && registered.get(selected.url)?.id === selected.id ? selected.url : selected?.id ?? "");
  }

  private makePreview(id: string, type: ValueType): PreviewTarget {
    const wrap = element("div", "nd-preview");
    wrap.dataset.type = type;
    const status = element("span", "nd-preview-status", "Loading…");
    const renderable = isRenderable(type);
    const canvas = renderable || type === "number" || type === "color" || type === "boolean" ? element("canvas", "nd-thumbnail") : undefined;
    if (canvas) {
      canvas.width = type === "color" ? 1 : 200;
      canvas.height = type === "color" ? 1 : renderable ? 112 : 36;
      wrap.append(canvas);
    }
    wrap.append(status);
    return { id, element: wrap, canvas, status, samples: [] };
  }

  private port(node: GraphNode, type: ValueType | undefined, connection: Omit<Port, "node">, outputLabel?: string) {
    const { input, output } = connection;
    const port = { node: node.id, ...connection };
    const socket = button("", () => {}, "nd-port");
    socket.dataset.port = node.id;
    if (type) socket.dataset.type = type;
    socket.dataset.input = input ?? "";
    if (output !== undefined) socket.dataset.output = output;
    const inputSocket = input ? inputsFor(this.graph, node).find(item => item.id === input) : undefined;
    const label = input ? (type && inputSocket?.label) || "Input" : outputLabel ?? "Output";
    const types = !type ? "Connect to choose a type" : inputSocket?.acceptsTextLayer ? "Image, Text or Color"
      : !input && isPixelOutput(this.graph, node, output) ? `${typeLabels[type]} per pixel` : typeLabels[type];
    const connected = this.edgesAt(port).length > 0;
    socket.dataset.tooltip = `${label} · ${types}${connected ? "\nAlt-click to disconnect" : ""}`;
    const useInputLabel = node.kind === "variable" || node.kind === "junction" || (node.kind === "colorRamp" && inputSocket?.type === "color");
    const inputName = input && !type ? "input" : useInputLabel ? inputSocket?.label : input;
    socket.setAttribute("aria-label", `${definition(node.kind).label} ${inputName ?? (outputLabel ? outputLabel + " output" : "output")} (${type ?? "unassigned"})`);
    socket.addEventListener("pointerdown", event => this.startWire(event, port));
    socket.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openMenu(this.portPosition(port)!, port);
    });
    socket.addEventListener("contextmenu", event => {
      if (!input) return;
      event.stopPropagation();
      event.preventDefault();
      const [edge] = this.edgesAt(port);
      if (edge) this.removeEdge(edge);
    });
    return socket;
  }

  private choiceField(node: GraphNode, key: string, choices: SelectChoice[], value: string, label: string,
    onChange: (value: string) => void, updateSockets = false,
  ) {
    return nodeChoiceField(choices, value, label, onChange, value => this.previewData(node.id, key, value, updateSockets)).field;
  }

  private clearChoicePreview() {
    const preview = this.choicePreview;
    this.choicePreview = undefined;
    if (!preview?.original) return;
    preview.alternate?.element.remove();
    preview.original.element.hidden = false;
  }

  private previewData(id: string, key: string, value?: string, updateSockets = false) {
    this.clearChoicePreview();
    if (value === undefined) return;
    const node = this.graph.nodes.find(item => item.id === id);
    if (!node || node.data[key] === value) return;
    const graph = this.graphWithData(node, key, value);
    const next = updateSockets ? keepCompatibleEdges(graph) : graph;
    const candidate = next.nodes.find(item => item.id === id);
    if (!candidate) return;
    this.choicePreview = { graph: next, id };
    const original = this.previews.find(target => target.id === id && !target.showRamp);
    if (!original) return;
    const type = previewType(next, candidate);
    if (!type || type === original.element.dataset.type) return;
    const alternate = this.makePreview(id, type);
    original.element.after(alternate.element);
    original.element.hidden = true;
    Object.assign(this.choicePreview, { original, alternate });
  }

  private graphWithData(node: GraphNode, key: string, value: Literal) {
    const data = { ...node.data, [key]: value };
    if (node.kind === "fontAxis" && key === "tag") {
      const axis = fontAxisFor(value);
      if (typeof axis?.value === "number") data.value = axis.value;
    }
    return { ...this.graph, nodes: this.graph.nodes.map(item => item.id === node.id ? { ...item, data } : item) };
  }

  private setData(node: GraphNode, key: string, value: Literal) {
    const current = this.graph.nodes.find(item => item.id === node.id);
    if (!current || current.data[key] === value) return;
    this.change(keepCompatibleEdges(this.graphWithData(current, key, value)));
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
    this.world.querySelector<HTMLElement>(".nd-choice-list:popover-open")?.hidePopover();
    this.showInsertion();
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
    const selector = port.input ? `[data-input="${port.input}"]` : port.output
      ? `[data-output="${port.output}"]` : '[data-input=""]:not([data-output])';
    const card = this.cards.get(port.node);
    const socket = card?.querySelector<HTMLElement>(card.dataset.kind === "cableEnd" ? ".nd-cable-handle" : selector);
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
      const from = this.portPosition({ node: edge.from, output: edge.output });
      const to = this.portPosition({ node: edge.to, input: edge.input });
      const node = this.graph.nodes.find(item => item.id === edge.from);
      if (!from || !to || !node) continue;
      const path = this.wirePath(from, to, outputType(this.graph, node, edge.output));
      const hit = path.cloneNode() as SVGPathElement;
      hit.classList.add("nd-wire-hit");
      const insertHit = path.cloneNode() as SVGPathElement;
      insertHit.classList.add("nd-wire-insert-hit");
      path.classList.toggle("nd-wire-selected", edge === this.selectedEdge);
      path.classList.toggle("nd-wire-inserting", edge === this.insertion?.edge);
      path.classList.toggle("nd-wire-muted", this.wireDrag?.detached.includes(edge) ?? false);
      hit.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.stopPropagation();
        this.viewport.focus();
        this.selectNodes();
        if (event.altKey) {
          event.preventDefault();
          this.removeEdge(edge);
          return;
        }
        this.selectedEdge = edge;
        path.classList.add("nd-wire-selected");
      });
      hit.addEventListener("dblclick", event => {
        event.preventDefault();
        event.stopPropagation();
        if (event.button !== 0 || this.cancelDrag || !this.graph.edges.includes(edge)) return;
        this.closeMenu();
        const point = this.worldPoint(this.local(event.clientX, event.clientY));
        const type = outputType(this.graph, node, edge.output);
        if (!type) return;
        const junction = makeNode("junction", point.x, point.y, { type });
        const edges = this.graph.edges.flatMap(item => item === edge ? [
          { from: edge.from, output: edge.output, to: junction.id, input: cableInput },
          { ...edge, from: junction.id, output: undefined },
        ] : [item]);
        this.selectNode(junction.id);
        this.change({ ...this.graph, nodes: [...this.graph.nodes, junction], edges });
      });
      hit.addEventListener("contextmenu", event => {
        event.preventDefault(); event.stopPropagation();
        const pos = this.local(event.clientX, event.clientY);
        this.showMenu(pos, [button("Disconnect", () => { this.closeMenu(); this.removeEdge(edge); })]);
      });
      this.wires.append(path, hit, insertHit);
      this.edgePaths.push({ edge, path, hit, insertHit });
    }
    if (this.wireDrag) {
      const { ports, point } = this.wireDrag;
      for (const port of ports) {
        const fixed = this.portPosition(port);
        const node = this.graph.nodes.find(item => item.id === port.node);
        if (!fixed || !node) continue;
        const type = port.input ? inputType(this.graph, node, port.input) : outputType(this.graph, node, port.output);
        const path = port.input ? this.wirePath(point, fixed, type) : this.wirePath(fixed, point, type);
        path.classList.add("nd-wire-drag");
        this.wires.append(path);
      }
    }
  }

  private selectNodes(ids: Iterable<string> = []) {
    this.showInsertion();
    this.selected = new Set(ids);
    if (this.selectedEdge) {
      this.edgePaths.find(item => item.edge === this.selectedEdge)?.path.classList.remove("nd-wire-selected");
      this.selectedEdge = undefined;
    }
    for (const [id, card] of this.cards) card.classList.toggle("is-selected", this.selected.has(id));
  }

  private get singleSelectedNode() {
    if (this.selected.size !== 1) return;
    const [id] = this.selected;
    return this.graph.nodes.find(node => node.id === id);
  }

  private selectNode(id: string, keepSelection = false) {
    if (!keepSelection || !this.selected.has(id)) this.selectNodes([id]);
    const zIndex = ++this.lastNodeZIndex;
    this.nodeZIndices.set(id, zIndex);
    const card = this.cards.get(id);
    if (card) card.style.zIndex = String(zIndex);
  }

  private alignSelectedNodes() {
    const nodes = this.graph.nodes.filter(node => this.selected.has(node.id)).sort((a, b) => a.x - b.x || a.y - b.y);
    if (nodes.length < 2) return;
    const { x: start, y } = nodes[0];
    const moved = new Map<string, GraphNode>();
    let nextX = start;
    for (const node of nodes) {
      const x = Math.max(node.x, nextX);
      const width = this.cards.get(node.id)?.offsetWidth ?? 0;
      nextX = x + width + alignedNodeGap;
      if (node.x !== x || node.y !== y) moved.set(node.id, { ...node, x, y });
    }
    if (!moved.size) return;
    this.viewport.focus();
    this.change({ ...this.graph, nodes: this.graph.nodes.map(node => moved.get(node.id) ?? node) });
  }

  private track(start: PointerEvent, move: (event: PointerEvent) => void, finish: (event?: PointerEvent) => void) {
    this.cancelDrag?.();
    this.cancelDrag = trackPointerDrag(start, move, event => {
      this.cancelDrag = undefined;
      finish(event);
    });
  }

  private startCanvasGesture(event: PointerEvent) {
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    if (event.button === 0 && (event.target as Element).closest(".nd-node, .nd-wire-hit, .nd-menu, .nd-variables, .nd-navigation")) return;
    event.preventDefault();
    this.cancelDrag?.();
    this.viewport.focus();
    this.closeMenu();
    this.variables.hidden = true;
    this.showInsertion();
    if (event.button === 1 || event.pointerType === "touch") {
      if (event.pointerType === "touch") this.selectNodes();
      this.startPan(event);
    } else {
      this.startBoxSelection(event);
    }
  }

  private startPan(event: PointerEvent) {
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

  private startBoxSelection(event: PointerEvent) {
    const start = this.local(event.clientX, event.clientY);
    const previous = this.selected;
    const previousEdge = this.selectedEdge;
    let dragged = false;
    const update = (move: PointerEvent) => {
      dragged ||= Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) > 4;
      if (!dragged) return;
      const viewport = this.viewport.getBoundingClientRect();
      const x = Math.max(0, Math.min(move.clientX - viewport.left, viewport.width));
      const y = Math.max(0, Math.min(move.clientY - viewport.top, viewport.height));
      const left = Math.min(start.x, x), right = Math.max(start.x, x);
      const top = Math.min(start.y, y), bottom = Math.max(start.y, y);
      const ids: string[] = [];
      for (const [id, card] of this.cards) {
        const bounds = card.getBoundingClientRect();
        if (bounds.right > viewport.left + left && bounds.left < viewport.left + right &&
            bounds.bottom > viewport.top + top && bounds.top < viewport.top + bottom) ids.push(id);
      }
      Object.assign(this.selectionBox.style, {
        left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`,
      });
      this.selectionBox.hidden = false;
      this.selectNodes(ids);
    };
    this.track(event, update, end => {
      if (end) {
        update(end);
        if (!dragged) this.selectNodes();
      } else if (dragged) {
        this.selectNodes([...previous].filter(id => this.cards.has(id)));
        if (previousEdge && this.graph.edges.includes(previousEdge)) {
          this.selectedEdge = previousEdge;
          this.drawWires();
        }
      }
      this.selectionBox.hidden = true;
    });
  }

  private startNodeMove(event: PointerEvent, node: GraphNode) {
    if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest(".nd-preview-toggle")) return;
    event.preventDefault();
    this.cancelDrag?.();
    this.viewport.focus();
    this.closeMenu();
    const card = this.cards.get(node.id);
    if (!card) return;
    this.selectNode(node.id, true);
    const moving = this.selected;
    const nodes = this.graph.nodes.filter(item => moving.has(item.id));
    const looseEnd = node.kind === "cableEnd" && nodes.length === 1;
    const reconnect = (port: Port) => this.reconnectCableEnd(node, port);
    let dx = 0, dy = 0;
    let moved = false;
    const moveNode = (move: PointerEvent) => {
      const pixelsX = move.clientX - event.clientX;
      const pixelsY = move.clientY - event.clientY;
      if (!moved) {
        if (Math.hypot(pixelsX, pixelsY) <= 4) return;
        moved = true;
        if (looseEnd) this.highlight(port => Boolean(reconnect(port)));
      }
      dx = pixelsX / this.view.zoom;
      dy = pixelsY / this.view.zoom;
      for (const item of nodes) {
        const element = this.cards.get(item.id);
        if (!element) continue;
        element.style.left = `${item.x + dx}px`;
        element.style.top = `${item.y + dy}px`;
      }
      this.drawWires();
      const insertion = nodes.length === 1 && !isCablePoint(node) ? this.insertionAtCard(node, card) : undefined;
      this.showInsertion(insertion, insertion?.point, true);
    };
    this.track(event, moveNode, end => {
      if (end) moveNode(end);
      const insertion = this.insertion;
      this.showInsertion();
      if (looseEnd) this.highlight(() => false);
      if (!moved) return;
      if (!end || (dx === 0 && dy === 0)) { this.render(); return; }
      if (looseEnd) {
        const under = document.elementsFromPoint(end.clientX, end.clientY).find(item => !card.contains(item)) ?? null;
        const target = this.dropPortAt(end.clientX, end.clientY, under, port => Boolean(reconnect(port)), card);
        const next = target && reconnect(target);
        if (next) { this.change(next); return; }
      }
      const next = insertion ? insertNodeOnEdge(this.graph, node, insertion.edge, insertion.input, insertion.output)?.graph ?? this.graph : this.graph;
      this.change({ ...next, nodes: next.nodes.map(item => moving.has(item.id) ? { ...item, x: item.x + dx, y: item.y + dy } : item) });
    });
  }

  private insertionAtCard(node: GraphNode, card: HTMLElement) {
    const anchors: { element: HTMLElement; port?: Port }[] = [{ element: card }];
    for (const socket of card.querySelectorAll<HTMLElement>("[data-port]")) {
      anchors.push({ element: socket, port: this.portFrom(socket) });
    }
    let nearby: (Insertion & { point: Point }) | undefined;
    for (const { element, port } of anchors) {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const under = document.elementsFromPoint(x, y).find(item => !card.contains(item));
      const point = this.local(x, y);
      const insertion = this.insertionAt(node, point, under, port);
      if (!insertion) continue;
      const proposal = { ...insertion, point };
      if (!insertion.padded) return proposal;
      nearby ??= proposal;
    }
    return nearby;
  }

  private insertionAt(node: GraphNode, point: Point, under?: Element, movingPort?: Port): Insertion | undefined {
    if (isCablePoint(node) || node.kind === "convert" || !under || !this.viewport.contains(under) || under.closest(".nd-navigation,.nd-menu,.nd-variables")) return;
    const resolve = (edge: GraphEdge): Insertion | undefined => {
      const output = movingPort && !movingPort.input ? movingPort.output ?? "" : undefined;
      const result = insertNodeOnEdge(this.graph, node, edge, movingPort?.input, output);
      if (result && (!movingPort || movingPort.input || result.spliced)) {
        return { edge, spliced: result.spliced, input: movingPort?.input, output };
      }
    };
    const row = under.closest(".nd-port-row");
    const port = this.portFrom(row?.querySelector(".nd-port") ?? under);
    if (port) {
      const edges = this.edgesAt(port);
      for (const { edge } of this.edgePaths) {
        if (!edges.includes(edge)) continue;
        const insertion = resolve(edge);
        if (insertion) return { ...insertion, atPort: true, padded: !under.closest(".nd-port") };
      }
      return;
    }
    if (under.closest(".nd-node")) return;
    const location = new DOMPoint(point.x, point.y);
    for (const area of ["hit", "insertHit"] as const) {
      for (const candidate of this.edgePaths) {
        if (!candidate[area].isPointInStroke(location)) continue;
        const insertion = resolve(candidate.edge);
        if (insertion) return { ...insertion, padded: area === "insertHit" };
      }
    }
  }

  private hoverInsertion(event: PointerEvent) {
    if (this.cancelDrag || !this.ghost.hidden || event.target === this.insertHint) return;
    const node = this.singleSelectedNode;
    const point = this.local(event.clientX, event.clientY);
    const insertion = node && event.buttons === 0 && event.pointerType !== "touch" && this.menu.hidden
      ? this.insertionAt(node, point, event.target as Element) : undefined;
    this.showInsertion(insertion, point);
  }

  private showInsertion(insertion?: Insertion, point?: Point, preview = false) {
    const previous = this.insertion;
    if (insertion && point && previous?.edge === insertion.edge && previous.spliced === insertion.spliced && previous.atPort === insertion.atPort &&
        previous.input === insertion.input && previous.output === insertion.output &&
        !preview && !this.insertHint.disabled && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) < 24) return;
    this.insertion = insertion && point ? { ...insertion, point } : undefined;
    this.edgePaths.find(item => item.edge === previous?.edge)?.path.classList.remove("nd-wire-inserting");
    this.insertHint.hidden = !this.insertion;
    if (!this.insertion) return;
    this.edgePaths.find(item => item.edge === this.insertion?.edge)?.path.classList.add("nd-wire-inserting");
    this.insertHint.textContent = this.insertion.spliced ? "Insert node here" : "Connect as branch";
    this.insertHint.disabled = preview;
    const width = this.insertHint.offsetWidth;
    const height = this.insertHint.offsetHeight;
    const anchor = this.insertion.point;
    this.insertHint.style.left = `${Math.max(4, Math.min(anchor.x - width / 2, this.viewport.clientWidth - width - 4))}px`;
    this.insertHint.style.top = `${anchor.y + height + 12 < this.viewport.clientHeight ? anchor.y + 8 : anchor.y - height - 8}px`;
  }

  private commitInsertion() {
    const insertion = this.insertion;
    const node = this.singleSelectedNode;
    const card = node && this.cards.get(node.id);
    if (!insertion || !node || !card) return;
    const result = insertNodeOnEdge(this.graph, node, insertion.edge, insertion.input, insertion.output);
    if (!result) { this.showInsertion(); return; }
    const path = insertion.atPort ? this.edgePaths.find(item => item.edge === insertion.edge)?.path : undefined;
    const point = this.worldPoint(path ? path.getPointAtLength(path.getTotalLength() / 2) : insertion.point);
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const x = point.x - width / 2;
    let y = point.y - Math.min(48, height / 2);
    const neighbors = this.graph.nodes.filter(item => item !== node).sort((a, b) => a.y - b.y);
    for (const other of neighbors) {
      const neighbor = this.cards.get(other.id);
      if (!neighbor || x + width + 12 <= other.x || x >= other.x + neighbor.offsetWidth + 12) continue;
      if (y + height + 12 > other.y && y < other.y + neighbor.offsetHeight + 12) y = other.y + neighbor.offsetHeight + 12;
    }
    this.change({ ...result.graph, nodes: result.graph.nodes.map(item => item === node ? { ...item, x, y } : item) });
    this.viewport.focus();
  }

  private startWire(event: PointerEvent, port: Port) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelDrag?.();
    this.viewport.focus();
    this.closeMenu();
    this.selectNode(port.node);
    if (event.altKey) {
      const connected = this.edgesAt(port);
      if (connected.length) this.disconnectEdges(connected);
      else this.drawWires();
      return;
    }
    const graph = this.graph;
    const existing = port.input ? this.edgesAt(port) : [];
    const detached = existing;
    const fixedPorts = existing.length ? existing.map(edge => ({ node: edge.from, output: edge.output })) : [port];
    const base = detached.length ? { ...graph, edges: graph.edges.filter(edge => !detached.includes(edge)) } : graph;
    const resolveDrop = (target: Port) => {
      if (!detached.length) return this.connect(graph, port, target, true);
      if (target.node === port.node && target.input === port.input) return graph;
      return fixedPorts.reduce<Graph | undefined>((next, fixed) => next && this.connect(next, fixed, target, true), base);
    };
    const acceptsDrop = (target: Port) => Boolean(resolveDrop(target));
    this.wireDrag = { ports: fixedPorts, point: this.local(event.clientX, event.clientY), detached };
    this.highlight(acceptsDrop);
    this.drawWires();
    this.track(event, move => {
      const under = document.elementFromPoint(move.clientX, move.clientY);
      const target = this.dropPortAt(move.clientX, move.clientY, under, acceptsDrop);
      const snap = target && acceptsDrop(target) ? this.portPosition(target) : undefined;
      this.wireDrag = { ports: fixedPorts, point: snap ?? this.local(move.clientX, move.clientY), detached };
      this.drawWires();
    }, end => {
      this.wireDrag = undefined;
      this.highlight(() => false);
      this.drawWires();
      if (!end || this.graph !== graph || Math.hypot(end.clientX - event.clientX, end.clientY - event.clientY) < 5) return;
      const under = document.elementFromPoint(end.clientX, end.clientY);
      const target = this.dropPortAt(end.clientX, end.clientY, under, acceptsDrop);
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
      : edge.from === port.node && edge.output === port.output);
  }

  private connect(graph: Graph, first: Port, second: Port, convert = false): Graph | undefined {
    const [from, to] = first.input ? [second, first] : [first, second];
    if (from.input || !to.input) return;
    if (graph.edges.some(edge => edge.from === from.node && edge.output === from.output && edge.to === to.node && edge.input === to.input)) return graph;
    const edge = { from: from.node, to: to.node, input: to.input, ...(from.output && { output: from.output }) };
    return convert ? this.completeWire(graph, edge) : withEdge(graph, edge);
  }

  private completeWire(graph: Graph, edge: GraphEdge) {
    return withConvertedEdge(graph, edge, () => {
      const source = this.portPosition({ node: edge.from, output: edge.output });
      const target = this.portPosition({ node: edge.to, input: edge.input });
      if (source && target) return this.worldPoint({ x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 });
    });
  }

  private reconnectCableEnd(node: GraphNode, port: Port): Graph | undefined {
    const graph = this.graph;
    const source = node.data.side === "source";
    if (port.node === node.id || Boolean(port.input) === source) return;
    const edge = graph.edges.find(item => (source ? item.from : item.to) === node.id);
    if (!edge) return;
    const base = { ...graph, nodes: graph.nodes.filter(item => item !== node), edges: graph.edges.filter(item => item !== edge) };
    const replacement = source ? { ...edge, from: port.node, output: port.output }
      : { from: edge.from, output: edge.output, to: port.node, input: port.input! };
    return this.completeWire(base, replacement);
  }

  private highlight(matches: (port: Port) => boolean) {
    for (const port of this.world.querySelectorAll<HTMLElement>("[data-port]")) port.classList.toggle("nd-port-compatible", matches(this.portFrom(port)!));
  }

  private portFrom(under: Element | null): Port | undefined {
    const port = under?.closest<HTMLElement>("[data-port]");
    if (port?.dataset.port && this.world.contains(port)) return { node: port.dataset.port, input: port.dataset.input || undefined, output: port.dataset.output };
  }

  private dropPortAt(x: number, y: number, under: Element | null, accepts: (port: Port) => boolean, moving?: HTMLElement): Port | undefined {
    if (!under || !this.viewport.contains(under) || under.closest(".nd-menu,.nd-variables,.nd-navigation,.nd-insert-hint")) return;
    const direct = this.portFrom(under);
    if (direct) return direct;

    const card = under.closest(".nd-node");
    let nearest: Port | undefined;
    let nearestDistance = Infinity;
    for (const socket of (card ?? this.world).querySelectorAll<HTMLElement>("[data-port]")) {
      const rect = socket.getBoundingClientRect();
      const dx = Math.max(rect.left - x, x - rect.right, 0);
      const dy = Math.max(rect.top - y, y - rect.bottom, 0);
      if (Math.hypot(dx, dy) > portDropPadding) continue;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distance = Math.hypot(centerX - x, centerY - y);
      if (distance >= nearestDistance) continue;
      const hit = moving ? document.elementsFromPoint(centerX, centerY).find(item => !moving.contains(item)) : document.elementFromPoint(centerX, centerY);
      if (hit !== socket) continue;
      const port = this.portFrom(socket)!;
      if (!accepts(port)) continue;
      nearest = port;
      nearestDistance = distance;
    }
    return nearest;
  }

  private receive(drop: NodeDrop | null, x: number, y: number, commit: boolean, options?: SidebarDropOptions): boolean {
    this.ghost.hidden = true;
    this.highlight(() => false);
    if (!drop || !this.visible) return false;
    const under = document.elementFromPoint(x, y);
    if (!under || !this.viewport.contains(under) || under.closest(".nd-menu,.nd-variables,.nd-navigation")) return false;
    const local = this.local(x, y);
    const point = this.worldPoint(local);
    const node: GraphNode = { id: "sidebar-drag", kind: drop.kind, x: point.x, y: point.y, data: drop.data ?? {} };
    const graph = { ...this.graph, nodes: [...this.graph.nodes, node] };
    const isFree = (port: Port) => !port.input || !graph.edges.some(edge => edge.to === port.node && edge.input === port.input);
    const acceptsDrop = (port: Port) => isFree(port) && Boolean(this.attach(graph, node, port));
    const target = this.dropPortAt(x, y, under, acceptsDrop);
    if (target) {
      // Leave room beside the target card for an automatically attached node.
      point.x += target.input ? -234 : 50;
      point.y -= 34;
      while (this.graph.nodes.some(item => Math.abs(item.x - point.x) < 190 && Math.abs(item.y - point.y) < 72)) point.y += 80;
    }
    const canPlace = target ? acceptsDrop(target) : !under.closest(".nd-node,.nd-wire-hit");
    if (commit) {
      if (canPlace) this.addAt(options?.prepare?.() ?? drop, point, target ? (graph, node) => this.attach(graph, node, target) : undefined);
    } else {
      this.highlight(acceptsDrop);
      if (!options?.hasThumbnail) {
        const item = definition(drop.kind);
        this.ghost.dataset.category = item.category;
        this.ghost.textContent = item.label;
        this.ghost.classList.toggle("blocked", !canPlace);
        this.ghost.style.left = `${local.x + 10}px`;
        this.ghost.style.top = `${local.y + 10}px`;
        this.ghost.hidden = false;
      }
    }
    return true;
  }

  addMedia(entry: MediaEntry) {
    const point = this.worldPoint({ x: this.viewport.clientWidth * 0.35, y: this.viewport.clientHeight * 0.35 });
    this.addAt({ kind: isTexture(entry) ? "texture" : "media", data: { media: entry.id } }, point);
  }

  private attach(graph: Graph, node: GraphNode, port: Port, allowConversion = true): Graph | undefined {
    const candidates = port.input
      ? node.kind === "convert" ? [{ node: node.id }] : outputsFor(graph, node).map(output => ({ node: node.id, output: output.id }))
      : inputsFor(graph, node).map(socket => ({ node: node.id, input: socket.id }));
    for (const convert of allowConversion ? [false, true] : [false]) {
      for (const candidate of candidates) {
        const next = this.connect(graph, port, candidate, convert);
        if (next) return next;
      }
    }
  }

  private addAt(drop: NodeDrop, point: Point, attach?: AttachNode) {
    const node = makeNode(drop.kind, point.x, point.y, drop.data);
    const graph = { ...this.graph, nodes: [...this.graph.nodes, node] };
    const next = attach ? attach(graph, node) : graph;
    if (!next) return false;
    this.selectNode(node.id);
    this.change(next);
    this.viewport.focus();
    return true;
  }

  private openMenu(point: Point, port?: Port, cable?: PendingCable) {
    this.closeMenu();
    this.variables.hidden = true;
    const position = this.worldPoint(point);
    const base = this.graph;
    const attach = port && ((graph: Graph, node: GraphNode, allowConversion = true) => {
      if (!cable) return this.attach(graph, node, port, allowConversion);
      const loose = { ...graph, edges: graph.edges.filter(edge => !cable.detached.includes(edge)) };
      const connected = cable.fixedPorts.reduce<Graph | undefined>((next, fixed) => next && this.attach(next, node, fixed, allowConversion), loose);
      return connected && (this.attach(connected, node, port, allowConversion) ?? connected);
    });
    const choices: MenuChoice[] = [];
    for (const kind of nodeKinds) {
      if (kind === "output") continue;
      const def = definition(kind);
      if (def.hidden) continue;
      const menuModes = kind === "blend" ? blendMenuModes : def.modes;
      const options = kind === "variable" && port
        ? base.variables.map(variable => ({ name: `Variable · ${variable.name}`, data: { variable: variable.id } }))
        : [{ name: def.label, data: kind === "variable" && base.variables.length === 1 ? { variable: base.variables[0].id } : undefined }];
      for (const option of options) {
        const node: GraphNode = { id: "menu-node", kind, ...position, data: option.data ?? {} };
        const compatible = (candidate: GraphNode, allowConversion = true) => {
          if (!attach) return true;
          const next = attach({ ...base, nodes: [...base.nodes, candidate] }, candidate, allowConversion);
          return Boolean(next && (kind !== "convert" || next.nodes.find(node => node.id === candidate.id)?.data.mode === candidate.data.mode));
        };
        const direct: NodeMode[] = [];
        const converted: NodeMode[] = [];
        for (const mode of menuModes ?? []) {
          const candidate = { ...node, data: { ...node.data, mode: mode.id } };
          if (compatible(candidate, false)) direct.push(mode);
          else if (compatible(candidate)) converted.push(mode);
        }
        const modes = menuModes && [...direct, ...converted];
        if (modes ? modes.length === 0 : !compatible(node)) continue;
        const search = [option.name, kind, ...(def.reference ?? []), ...(def.aliases ?? [])];
        if (kind === "expression" && modes) {
          for (const mode of modes) {
            choices.push({
              drop: { kind, data: { ...option.data, mode: mode.id } }, name: mode.label, category: def.category,
              search: [...search, `${option.name} ${mode.label}`, mode.label, ...(mode.reference ?? []), ...(mode.aliases ?? [])],
            });
          }
          continue;
        }
        choices.push({
          drop: { kind, data: option.data }, name: option.name, category: def.category, modes, defaultMode: menuModes?.[0], search,
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
    this.showInsertion();
    this.dismissMenu = dismiss;
    this.menu.replaceChildren(...children);
    this.menu.classList.toggle("nd-catalog-menu", catalog);
    this.menuAnchor = point;
    this.menu.hidden = false;
    if (catalog && typeof this.menu.showPopover === "function") {
      this.menu.setAttribute("popover", "manual");
      this.menu.showPopover();
    }
    this.positionMenu();
  }

  private positionMenu() {
    const point = this.menuAnchor;
    if (!point) return;
    const catalog = this.menu.classList.contains("nd-catalog-menu");
    const fixed = this.menu.hasAttribute("popover");
    const bounds = this.viewport.getBoundingClientRect();
    const panelHeight = Math.min(420, Math.max(0, this.viewport.clientHeight - 8));
    this.menu.style.setProperty("--nd-menu-height", `${panelHeight}px`);
    this.menu.style.setProperty("--nd-menu-width", `${Math.min(536, Math.max(0, this.viewport.clientWidth - 8))}px`);
    const height = catalog ? panelHeight : this.menu.offsetHeight;
    const x = Math.max(4, Math.min(point.x, this.viewport.clientWidth - this.menu.offsetWidth - 4));
    const y = Math.max(4, Math.min(point.y, this.viewport.clientHeight - height - 4));
    this.menu.style.left = `${x + (fixed ? bounds.left : 0)}px`;
    this.menu.style.top = `${y + (fixed ? bounds.top : 0)}px`;
  }

  private closeMenu(dismiss = true) {
    const action = this.dismissMenu;
    this.dismissMenu = undefined;
    this.menuAnchor = undefined;
    if (!this.menu.hidden) this.dismissTooltip();
    if (this.menu.hasAttribute("popover")) {
      this.menu.hidePopover();
      this.menu.removeAttribute("popover");
    }
    this.menu.hidden = true;
    if (dismiss) action?.();
  }

  private openActions(node: GraphNode, point: Point) {
    this.closeMenu();
    this.selectNode(node.id, true);
    if (this.selected.size > 1) {
      this.showMenu(point, [button("Delete selected nodes", () => this.removeNodes(this.selected), "nd-menu-item")]);
      return;
    }
    const choices: HTMLButtonElement[] = [];
    if (node.kind === "output") {
      choices.push(button("Duplicate node", () => { this.closeMenu(); this.duplicateOutput(node); }, "nd-menu-item"));
    }
    if (this.canRemoveNode(node)) {
      const label = node.kind === "junction" ? "Delete junction" : node.kind === "cableEnd" ? "Delete cable end"
        : node.kind === "convert" ? "Delete conversion" : "Delete node";
      const ids = new Set([node.id]);
      choices.push(button(label, () => this.removeNodes(ids), "nd-menu-item"));
      if (node.kind === "junction") {
        choices.push(button("Delete junction and keep cable ends", () => this.removeNodes(ids, { keepCableEnds: true }), "nd-menu-item"));
      }
    }
    if (isCablePoint(node) || node.kind === "convert") { this.showMenu(point, choices); return; }
    const input = this.graph.edges.find(edge => edge.to === node.id && edge.input === inputsFor(this.graph, node)[0]?.id);
    const outgoing = this.graph.edges.filter(edge => edge.from === node.id);
    if (input && outgoing.length) {
      const base = { ...this.graph, edges: this.graph.edges.filter(edge => edge !== input && edge.from !== node.id) };
      let next: Graph | undefined = base;
      for (const edge of outgoing) next = next && withEdge(next, { ...input, to: edge.to, input: edge.input });
      if (next) {
        const graph = next;
        choices.unshift(button("Detach from chain", () => { this.closeMenu(); this.change(graph); }, "nd-menu-item"));
      }
    }
    this.showMenu(point, choices);
  }

  private duplicateOutput(node: GraphNode) {
    const card = this.cards.get(node.id);
    if (!card) return;
    const gap = 16;
    const width = card.offsetWidth;
    // Duplicating the only output adds a layer selector to both cards.
    const height = card.offsetHeight + (this.canRemoveNode(node) ? 0 : 32);
    let y = node.y + height + gap;
    const neighbors = [...this.graph.nodes].sort((a, b) => a.y - b.y);
    for (const other of neighbors) {
      const neighbor = this.cards.get(other.id);
      if (!neighbor || other.x + neighbor.offsetWidth <= node.x || other.x >= node.x + width) continue;
      const bottom = other.y + neighbor.offsetHeight + gap;
      if (y < bottom && y + height + gap > other.y) y = bottom;
    }
    this.addAt({ kind: "output", data: { ...node.data } }, { x: node.x, y });
  }

  private canRemoveNode(node: GraphNode) {
    return node.kind !== "output" || this.graph.nodes.some(item => item.kind === "output" && item.id !== node.id);
  }

  private removeNodes(ids: ReadonlySet<string>, { keepCableEnds = false } = {}) {
    const outputs = this.graph.nodes.filter(node => node.kind === "output");
    const retainedOutput = outputs.every(node => ids.has(node.id)) ? outputs[0]?.id : undefined;
    const removed = new Set(this.graph.nodes.filter(node => ids.has(node.id) && node.id !== retainedOutput).map(node => node.id));
    if (!removed.size) return;
    this.closeMenu();
    this.view.previews = this.view.previews.filter(id => !removed.has(id));
    this.selectNodes();
    const graph = this.graph;
    const nodes = graph.nodes.filter(node => !removed.has(node.id));
    const junctions = new Map(graph.nodes.filter(node => keepCableEnds && node.kind === "junction" && removed.has(node.id))
      .map(node => [node.id, node]));
    const branches = new Map<string, GraphEdge[]>();
    for (const edge of graph.edges) {
      if (junctions.has(edge.from) && !removed.has(edge.to)) {
        const outgoing = branches.get(edge.from) ?? [];
        outgoing.push(edge);
        branches.set(edge.from, outgoing);
      }
    }
    const edges = graph.edges.flatMap(edge => {
      const missingSource = removed.has(edge.from);
      const missingTarget = removed.has(edge.to);
      if (!missingSource && !missingTarget) return [edge];
      if (missingSource && missingTarget) return [];
      const junction = junctions.get(missingSource ? edge.from : edge.to);
      if (!junction) return [];
      const type = cableType(junction);
      if (!type) return [];
      const outgoing = branches.get(junction.id);
      const offset = missingSource && outgoing ? (outgoing.indexOf(edge) - (outgoing.length - 1) / 2) * 24 : 0;
      const end = makeNode("cableEnd", junction.x + (missingSource ? 30 : -30), junction.y + offset, {
        type, side: missingSource ? "source" : "target",
      });
      nodes.push(end);
      return [missingSource ? { ...edge, from: end.id, output: undefined } : { ...edge, to: end.id, input: cableInput }];
    });
    this.change({ ...graph, nodes, edges });
    this.viewport.focus();
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
    let kind: ValueType = "number";
    const kinds = nodeChoiceField<ValueType>(valueTypes.map(type => [type, typeLabels[type], undefined, undefined, type]),
      kind, "Variable type", type => { kind = type; });
    const add = () => {
      const name = input.value.trim();
      if (!name || this.graph.variables.some(variable => variable.name === name)) return;
      this.change({ ...this.graph, variables: [...this.graph.variables, { id: crypto.randomUUID(), name, type: kind }] });
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
    create.append(input, kinds.field, button("Add", add));
    this.variables.append(create);
  }

  private keydown(event: KeyboardEvent) {
    if (!this.visible) return;
    const target = event.target as Element;
    if (event.key === "Escape") {
      this.cancelDrag?.();
      if (document.activeElement === this.insertHint) this.viewport.focus();
      this.showInsertion();
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
    if (target.closest("input,select,textarea,.nd-color-popover,.nd-choice-field") || !this.host.contains(target)) return;
    if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      this.cancelDrag?.();
      if (event.shiftKey || event.key.toLowerCase() === "y") this.redo(); else this.undo();
    }
    if (event.key.toLowerCase() === "q" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
        !event.defaultPrevented && !event.isComposing && !this.cancelDrag && this.menu.hidden && this.selected.size > 1) {
      event.preventDefault();
      this.alignSelectedNodes();
    }
    if (event.key === "Delete" && !this.cancelDrag && !target.closest(".nd-gradient, .nd-color-field")) {
      if (this.selectedEdge) this.removeEdge(this.selectedEdge);
      else if (this.selected.size) this.removeNodes(this.selected);
    }
  }
}
