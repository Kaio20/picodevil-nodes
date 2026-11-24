import { bindNumberDrag } from "./node-number-input";

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];
const storageKey = "nodesdevil-projection-v1";
const widthKey = "nodesdevil-projection-width";
const roundingKey = "nodesdevil-projection-rounding";
const minWidth = 180;
const defaultQuad = (): Quad => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

function validQuad(quad: Quad): boolean {
  return quad.every((a, i) => {
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.x > 1 || a.y < 0 || a.y > 1) return false;
    const b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    return b && c && (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) > 0.002;
  });
}

function loadQuad(): Quad {
  try {
    const quad = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Quad | null;
    if (Array.isArray(quad) && quad.length === 4 && validQuad(quad)) return quad;
  } catch { /* An invalid calibration opens with the full frame. */ }
  return defaultQuad();
}

function loadWidth(): number {
  try {
    const width = Number(localStorage.getItem(widthKey));
    if (Number.isFinite(width) && width >= minWidth) return width;
  } catch { /* The default size also works without storage. */ }
  return 320;
}

function clampRounding(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function loadRounding(): number {
  try {
    const value = Number(localStorage.getItem(roundingKey));
    if (Number.isFinite(value)) return clampRounding(value);
  } catch { /* The full frame also works without storage. */ }
  return 0;
}

/** Map the source rectangle to the four corners with one projective transform. */
export function quadTransform(quad: Quad, width: number, height: number): string {
  const [a, b, c, d] = quad;
  const x1 = b.x - c.x, x2 = d.x - c.x, x3 = a.x - b.x + c.x - d.x;
  const y1 = b.y - c.y, y2 = d.y - c.y, y3 = a.y - b.y + c.y - d.y;
  const det = x1 * y2 - x2 * y1;
  const g = (x3 * y2 - x2 * y3) / det;
  const h = (x1 * y3 - x3 * y1) / det;
  return `matrix3d(${[
    b.x - a.x + g * b.x, (b.y - a.y + g * b.y) * height / width, 0, g / width,
    (d.x - a.x + h * d.x) * width / height, d.y - a.y + h * d.y, 0, h / height,
    0, 0, 1, 0,
    a.x * width, a.y * height, 0, 1,
  ].join(",")})`;
}

function copyFrame(source: HTMLCanvasElement, target: HTMLCanvasElement, pixelWidth: number, pixelHeight: number) {
  const scale = Math.min(1, pixelWidth / source.width, pixelHeight / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(source, 0, 0, width, height);
}

export class NodeProjection {
  private quad = loadQuad();
  private rounding = loadRounding();
  private panel = document.createElement("section");
  private stage = document.createElement("div");
  private preview = document.createElement("canvas");
  private message = document.createElement("span");
  private corners: HTMLButtonElement[] = [];
  private popup: Window | null = null;
  private outputCanvas?: HTMLCanvasElement;
  private toggleButton?: HTMLButtonElement;
  private expanded = true;
  private width = loadWidth();
  private aspect = 16 / 9;
  private previewSize = { width: 0, height: 0 };

  constructor(private changed: () => void) {
    this.panel.className = "nd-projection";
    this.panel.id = "nd-projection";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "Projection calibration");
    this.setWidth(this.width);
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "Projection";
    const reset = document.createElement("button");
    reset.className = "nd-button";
    reset.textContent = "Reset";
    const close = document.createElement("button");
    close.className = "nd-button nd-projection-close";
    close.setAttribute("aria-label", "Close projection calibration");
    close.textContent = "×";
    close.addEventListener("click", () => this.setExpanded(false));
    const resize = document.createElement("button");
    resize.className = "nd-projection-resize";
    resize.type = "button";
    resize.title = "Drag to resize the projection preview";
    resize.setAttribute("aria-label", "Resize projection preview");
    resize.addEventListener("pointerdown", event => this.dragResize(event));
    resize.addEventListener("keydown", event => {
      const direction = Number(event.key === "ArrowLeft" || event.key === "ArrowUp")
        - Number(event.key === "ArrowRight" || event.key === "ArrowDown");
      if (!direction) return;
      event.preventDefault();
      this.resizeTo(this.panel.getBoundingClientRect().width + direction * (event.shiftKey ? 48 : 16));
      this.saveWidth();
    });
    this.stage.className = "nd-projection-stage";
    this.stage.append(this.preview);
    for (const [index, name] of ["Top left", "Top right", "Bottom right", "Bottom left"].entries()) {
      const handle = document.createElement("button");
      handle.className = "nd-projection-corner";
      handle.setAttribute("aria-label", name);
      handle.addEventListener("pointerdown", event => this.dragCorner(event, index));
      handle.addEventListener("keydown", event => {
        const x = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
        const y = Number(event.key === "ArrowDown") - Number(event.key === "ArrowUp");
        if (!x && !y) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.05 : 0.01;
        this.moveCorner(index, this.quad[index].x + x * step, this.quad[index].y + y * step);
        this.save();
      });
      this.corners.push(handle);
      this.stage.append(handle);
    }
    const controls = document.createElement("div");
    controls.className = "nd-projection-controls";
    const roundingLabel = document.createElement("label");
    roundingLabel.className = "nd-projection-radius";
    roundingLabel.textContent = "Corner Radius";
    const roundingInput = document.createElement("input");
    roundingInput.className = "nd-field";
    roundingInput.type = "number";
    roundingInput.min = "0";
    roundingInput.max = "100";
    roundingInput.value = String(this.rounding);
    const updateRounding = (value: number) => {
      if (!Number.isFinite(value)) return;
      this.rounding = clampRounding(value);
      this.layout();
    };
    const commitRounding = () => {
      roundingInput.value = String(this.rounding);
      this.saveRounding();
    };
    roundingInput.addEventListener("input", () => updateRounding(roundingInput.valueAsNumber));
    roundingInput.addEventListener("change", commitRounding);
    bindNumberDrag(roundingInput, 1, value => {
      updateRounding(value);
      commitRounding();
    });
    reset.addEventListener("click", () => {
      this.quad = defaultQuad();
      this.rounding = 0;
      roundingInput.value = "0";
      this.save();
      this.saveRounding();
      this.layout();
    });
    roundingLabel.append(roundingInput);
    controls.append(roundingLabel, reset);
    header.append(title, controls, close);
    this.message.className = "nd-projection-status";
    this.message.setAttribute("role", "status");
    this.panel.append(header, this.stage, this.message, resize);
    document.body.append(this.panel);
    new ResizeObserver(() => this.layout()).observe(this.stage);
    window.addEventListener("pagehide", () => this.popup?.close());
  }

  get outputWindow(): Window | null {
    return this.popup && !this.popup.closed ? this.popup : null;
  }

  bindToggle(button: HTMLButtonElement) {
    this.toggleButton = button;
    button.setAttribute("aria-controls", this.panel.id);
    button.setAttribute("aria-expanded", String(!this.panel.hidden));
    button.addEventListener("click", () => this.setExpanded(this.panel.hidden));
  }

  setWorkspace(visible: boolean) {
    this.setVisible(visible && this.expanded);
  }

  private setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.setVisible(expanded);
  }

  private setVisible(visible: boolean) {
    this.panel.hidden = !visible;
    this.toggleButton?.setAttribute("aria-expanded", String(visible));
    if (visible) this.layout();
  }

  open() {
    if (this.outputWindow) { this.outputWindow.focus(); return; }
    const output = window.open("", "_blank", "popup,width=960,height=540");
    if (!output) {
      this.setExpanded(true);
      this.message.textContent = "Allow pop-ups to open the output window.";
      return;
    }
    this.popup = output;
    this.message.textContent = "Double-click the output or press F for fullscreen.";
    const doc = output.document;
    doc.title = "NodesDevil Output";
    doc.documentElement.lang = "en";
    doc.documentElement.style.cssText = "width:100%;height:100%;background:#000";
    doc.body.style.cssText = "margin:0;width:100%;height:100%;overflow:hidden;background:#000;cursor:none";
    const canvas = doc.createElement("canvas");
    canvas.setAttribute("aria-label", "NodesDevil live output. Press F for fullscreen.");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;transform-origin:0 0;display:block";
    doc.body.replaceChildren(canvas);
    this.outputCanvas = canvas;
    const fullscreen = () => {
      const operation = doc.fullscreenElement ? doc.exitFullscreen() : doc.documentElement.requestFullscreen();
      void operation.catch(() => { this.setExpanded(true); this.message.textContent = "Fullscreen was blocked by the browser."; });
    };
    doc.addEventListener("dblclick", fullscreen);
    doc.addEventListener("keydown", event => { if (event.key.toLowerCase() === "f") fullscreen(); });
    output.addEventListener("resize", () => { this.layout(); this.changed(); });
    doc.addEventListener("visibilitychange", this.changed);
    doc.addEventListener("fullscreenchange", () => { this.layout(); this.changed(); });
    output.addEventListener("pagehide", () => {
      if (this.popup !== output) return;
      this.popup = null;
      this.outputCanvas = undefined;
      this.message.textContent = "";
      this.changed();
    });
    this.layout();
    this.changed();
  }

  present(source: HTMLCanvasElement) {
    const output = this.outputWindow;
    if (this.outputCanvas && output && !output.document.hidden) copyFrame(source, this.outputCanvas, source.width, source.height);
    if (!this.panel.hidden && !document.hidden) {
      const aspect = source.width / source.height;
      if (aspect !== this.aspect) {
        this.aspect = aspect;
        this.panel.style.setProperty("--nd-projection-aspect", String(aspect));
        this.layout();
      }
      const { width, height } = this.previewSize;
      if (width && height) copyFrame(source, this.preview, width * devicePixelRatio, height * devicePixelRatio);
    }
  }

  private dragCorner(event: PointerEvent, index: number) {
    const original = this.quad;
    this.trackDrag(event, move => {
      const rect = this.stage.getBoundingClientRect();
      this.moveCorner(index, (move.clientX - rect.left) / rect.width, (move.clientY - rect.top) / rect.height);
    }, commit => {
      if (commit) this.save();
      else { this.quad = original; this.layout(); }
    });
  }

  private dragResize(event: PointerEvent) {
    const original = this.width;
    const startWidth = this.panel.getBoundingClientRect().width;
    const inverseAspect = 1 / this.aspect;
    this.trackDrag(event, move => {
      const dx = event.clientX - move.clientX;
      const dy = event.clientY - move.clientY;
      // Project the pointer movement onto the aspect-locked diagonal.
      this.resizeTo(startWidth + (dx + dy * inverseAspect) / (1 + inverseAspect ** 2));
    }, commit => {
      if (commit) this.saveWidth(); else this.setWidth(original);
    });
  }

  private trackDrag(event: PointerEvent, move: (event: PointerEvent) => void, finish: (commit: boolean) => void) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLButtonElement;
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    const controller = new AbortController();
    const { signal } = controller;
    const end = (commit: boolean) => {
      controller.abort();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      finish(commit);
    };
    handle.addEventListener("pointermove", move, { signal });
    handle.addEventListener("pointerup", () => end(true), { signal });
    handle.addEventListener("pointercancel", () => end(false), { signal });
    handle.addEventListener("lostpointercapture", () => end(false), { signal });
    document.addEventListener("keydown", key => { if (key.key === "Escape") end(false); }, { signal });
  }

  private moveCorner(index: number, x: number, y: number) {
    const next = [...this.quad] as Quad;
    next[index] = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    if (!validQuad(next)) return;
    this.quad = next;
    this.layout();
  }

  private layout() {
    const rect = this.stage.getBoundingClientRect();
    this.previewSize = { width: rect.width, height: rect.height };
    if (rect.width > 0 && rect.height > 0) this.layoutCanvas(this.preview, rect.width, rect.height);
    this.quad.forEach(({ x, y }, index) => {
      this.corners[index].style.left = `${x * 100}%`;
      this.corners[index].style.top = `${y * 100}%`;
    });
    const output = this.outputWindow;
    if (output && this.outputCanvas) this.layoutCanvas(this.outputCanvas, Math.max(1, output.innerWidth), Math.max(1, output.innerHeight));
  }

  private layoutCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
    canvas.style.transform = quadTransform(this.quad, width, height);
    const amount = this.rounding / 100;
    const shortSide = Math.min(width, height);
    // Crop the longer side towards a square so full rounding yields a circle.
    const insetX = (width - shortSide) * amount / 2;
    const insetY = (height - shortSide) * amount / 2;
    const radius = shortSide * amount / 2;
    canvas.style.clipPath = amount ? `inset(${insetY}px ${insetX}px round ${radius}px)` : "";
  }

  private save() {
    try { localStorage.setItem(storageKey, JSON.stringify(this.quad)); } catch { /* The current calibration still works. */ }
  }

  private saveRounding() {
    try { localStorage.setItem(roundingKey, String(this.rounding)); } catch { /* The current rounding still works. */ }
  }

  private resizeTo(width: number) {
    const limit = Number.parseFloat(getComputedStyle(this.panel).maxWidth);
    this.setWidth(Math.max(minWidth, Math.min(Math.round(width), Number.isFinite(limit) ? limit : Infinity)));
  }

  private setWidth(width: number) {
    this.width = width;
    this.panel.style.setProperty("--nd-projection-width", `${width}px`);
  }

  private saveWidth() {
    try { localStorage.setItem(widthKey, String(this.width)); } catch { /* The current size remains usable. */ }
  }
}
