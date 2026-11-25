import { clampUnit, rgbHex, type ColorValue } from "./color-value";
import { gradientPixels, gradientResolution, gradientSampler, maxGradientStops, rgbInterpolations, type Gradient } from "./gradient";
import type { RampStop } from "./node-graph";
import { trackPointerDrag } from "./node-number-input";

export function gradientField(
  stops: readonly RampStop[], initialColors: ReadonlyMap<string, ColorValue>, interpolation: Gradient["interpolation"],
  change: (stops: readonly RampStop[], active: string, added?: ColorValue) => void,
  changeInterpolation: (interpolation: Gradient["interpolation"]) => void,
) {
  let positions = stops;
  let active = stops[0].id;
  const colors = new Map(initialColors);
  let wiredColors: Map<string, ColorValue> | undefined;

  const field = document.createElement("div");
  field.className = "nd-gradient";
  field.setAttribute("role", "group");
  field.setAttribute("aria-label", "Gradient editor");

  const toolbar = document.createElement("div");
  toolbar.className = "nd-gradient-toolbar";
  const button = (label: string, icon: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nd-button";
    button.textContent = icon;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    return button;
  };
  const add = button("Add color stop", "+");
  const remove = button("Remove color stop", "−");
  add.disabled = stops.length >= maxGradientStops;
  remove.disabled = stops.length <= 1;

  const select = document.createElement("select");
  select.className = "nd-field";
  select.setAttribute("aria-label", "Gradient interpolation");
  select.append(...rgbInterpolations.map(value => new Option(value)));
  select.value = interpolation;
  toolbar.append(add, remove, select);

  const track = document.createElement("div");
  track.className = "nd-gradient-track";
  const canvas = document.createElement("canvas");
  canvas.width = gradientResolution;
  canvas.height = 1;
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.tooltip = "Double-click to add a color stop here.";
  track.append(canvas);
  field.append(toolbar, track);

  const colorAt = (id: string) => wiredColors?.get(id) ?? colors.get(id)!;
  const gradient = (): Gradient => ({
    interpolation,
    stops: positions.map(({ id, position }) => {
      const { hex, alpha } = colorAt(id);
      return { position, color: hex, alpha };
    }),
  });
  const handles = new Map<string, HTMLButtonElement>();
  const draw = () => {
    [...positions].sort((a, b) => a.position - b.position).forEach(({ id, position }, index) => {
      const handle = handles.get(id)!;
      handle.style.left = `${position * 100}%`;
      handle.style.setProperty("--nd-stop-color", colorAt(id).hex);
      handle.setAttribute("aria-label", `Color stop ${index + 1} at ${position}`);
      handle.setAttribute("aria-pressed", String(id === active));
    });
    const pixels = gradientPixels(gradient(), canvas.width);
    canvas.getContext("2d")!.putImageData(new ImageData(pixels, canvas.width, 1), 0, 0);
  };

  const moveStop = (id: string, position: number) => {
    positions = stops.map(stop => stop.id === id ? { ...stop, position: Number(clampUnit(position).toFixed(3)) } : stop);
    draw();
  };
  for (const { id, position } of stops) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "nd-gradient-stop";
    handle.dataset.rampStop = id;
    handle.addEventListener("focus", () => { active = id; draw(); });
    handle.addEventListener("keydown", event => {
      const direction = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
      if (!direction) return;
      event.preventDefault();
      moveStop(id, position + direction * (event.shiftKey ? 0.05 : 0.01));
      if (positions.find(stop => stop.id === id)!.position !== position) change(positions, id);
    });
    handle.addEventListener("pointerdown", start => {
      if (start.button !== 0 || !start.isPrimary) return;
      start.preventDefault();
      handle.focus();
      const width = track.getBoundingClientRect().width;
      trackPointerDrag(start, move => moveStop(id, position + (move.clientX - start.clientX) / width), end => {
        if (!handle.isConnected) return;
        if (!end) { positions = stops; draw(); }
        else if (positions.find(stop => stop.id === id)!.position !== position) change(positions, id);
      });
    });
    handles.set(id, handle);
    track.append(handle);
  }

  const addStop = (position: number) => {
    if (add.disabled) return;
    position = Number(clampUnit(position).toFixed(3));
    const rgba = gradientSampler(gradient())(position);
    const id = `stop-${crypto.randomUUID()}`;
    change([...stops, { id, position }], id, { hex: rgbHex(rgba), alpha: rgba[3] });
  };
  add.addEventListener("click", () => {
    const edges = [0, ...stops.map(stop => stop.position), 1];
    let widest = 0, midpoint = 0.5;
    for (let i = 1; i < edges.length; i++) {
      const span = edges[i] - edges[i - 1];
      if (span <= widest) continue;
      widest = span;
      midpoint = edges[i - 1] + span / 2;
    }
    addStop(midpoint);
  });
  const addAtPointer = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    addStop((event.clientX - rect.left) / rect.width);
  };
  canvas.addEventListener("dblclick", event => {
    if (!event.ctrlKey && !event.metaKey) addAtPointer(event);
  });
  canvas.addEventListener("click", event => {
    if (event.ctrlKey || event.metaKey) addAtPointer(event);
  });
  remove.addEventListener("click", () => {
    const index = stops.findIndex(stop => stop.id === active);
    const next = stops.filter(stop => stop.id !== active);
    change(next, next[Math.min(index, next.length - 1)].id);
  });
  select.addEventListener("change", () => {
    interpolation = select.value as Gradient["interpolation"];
    draw();
    changeInterpolation(interpolation);
  });
  draw();
  return {
    field,
    setColor(id: string, color: ColorValue) { colors.set(id, color); draw(); },
    showGradient(wired: ReadonlySet<string>, value?: Gradient) {
      wiredColors = value && new Map(stops.flatMap(({ id }, index) => {
        if (!wired.has(id)) return [];
        const { color: hex, alpha } = value.stops[index];
        return [[id, { hex, alpha }]];
      }));
      draw();
    },
  };
}
