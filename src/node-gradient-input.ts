import {
  clampUnit, gradientPixels, gradientResolution, gradientSampler, gradientSpaces, hueInterpolations,
  maxGradientStops, rgbHex, rgbInterpolations, type Gradient, type GradientStop,
} from "./gradient";
import { bindNumberDrag, trackPointerDrag } from "./node-number-input";

export function gradientField(initial: Gradient, commit: (value: Gradient) => void) {
  let gradient = initial;
  let active = 0;
  const field = document.createElement("div");
  field.className = "nd-gradient";
  field.setAttribute("role", "group");
  field.setAttribute("aria-label", "Gradient editor");

  const toolbar = document.createElement("div");
  toolbar.className = "nd-gradient-toolbar";
  const add = document.createElement("button");
  const remove = document.createElement("button");
  for (const [button, label, icon] of [[add, "Add color stop", "+"], [remove, "Remove color stop", "−"]] as const) {
    button.type = "button";
    button.className = "nd-button";
    button.textContent = icon;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
  }
  const space = document.createElement("select");
  space.className = "nd-field";
  space.setAttribute("aria-label", "Gradient color space");
  space.append(...gradientSpaces.map(value => new Option(value)));
  const interpolation = document.createElement("select");
  interpolation.className = "nd-field";
  interpolation.setAttribute("aria-label", "Gradient interpolation");
  toolbar.append(add, remove, space, interpolation);

  const track = document.createElement("div");
  track.className = "nd-gradient-track";
  const canvas = document.createElement("canvas");
  canvas.width = gradientResolution;
  canvas.height = 1;
  canvas.setAttribute("aria-hidden", "true");
  track.append(canvas);

  const settings = document.createElement("div");
  settings.className = "nd-gradient-settings";
  const stopPicker = document.createElement("select");
  stopPicker.className = "nd-field";
  stopPicker.setAttribute("aria-label", "Active color stop");
  const position = document.createElement("input");
  const alpha = document.createElement("input");
  for (const input of [position, alpha]) {
    input.className = "nd-field";
    input.type = "number";
    input.min = "0";
    input.max = "1";
    input.step = "0.001";
  }
  const color = document.createElement("input");
  color.className = "nd-field nd-gradient-color";
  color.type = "color";
  const label = (text: string, input: HTMLInputElement) => {
    const label = document.createElement("label");
    label.textContent = text;
    label.append(input);
    return label;
  };
  settings.append(stopPicker, label("Position", position), label("Color", color), label("Alpha", alpha));
  field.append(toolbar, track, settings);

  let handles: HTMLButtonElement[] = [];
  const drawRamp = () => {
    const pixels = gradientPixels(gradient, canvas.width);
    canvas.getContext("2d")!.putImageData(new ImageData(pixels, canvas.width, 1), 0, 0);
  };

  const refreshStops = () => {
    const stop = gradient.stops[active];
    position.value = String(stop.position);
    alpha.value = String(stop.alpha);
    color.value = stop.color;
    add.disabled = gradient.stops.length >= maxGradientStops;
    remove.disabled = gradient.stops.length <= 1;
    const ordered = gradient.stops.map((stop, index) => ({ stop, index })).sort((a, b) => a.stop.position - b.stop.position);
    stopPicker.replaceChildren(...ordered.map(({ index }, order) => new Option(`Stop ${order + 1}`, String(index))));
    stopPicker.value = String(active);
    ordered.forEach(({ stop, index }, order) => {
      const handle = handles[index];
      handle.style.left = `${stop.position * 100}%`;
      handle.style.setProperty("--nd-stop-color", stop.color);
      handle.setAttribute("aria-label", `Color stop ${order + 1} at ${stop.position}`);
      handle.setAttribute("aria-pressed", String(index === active));
    });
    drawRamp();
  };

  const updateStop = (patch: Partial<GradientStop>) => {
    const stops = gradient.stops.map((stop, index) => index === active ? { ...stop, ...patch } : stop);
    gradient = { ...gradient, stops };
    refreshStops();
  };

  const replaceHandles = () => {
    for (const handle of handles) handle.remove();
    handles = gradient.stops.map((_, index) => {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "nd-gradient-stop";
      handle.addEventListener("click", () => { active = index; refreshStops(); });
      handle.addEventListener("keydown", event => {
        const direction = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
        if (!direction) return;
        event.preventDefault();
        active = index;
        const next = gradient.stops[index].position + direction * (event.shiftKey ? 0.05 : 0.01);
        updateStop({ position: clampUnit(Number(next.toFixed(3))) });
        commit(gradient);
      });
      handle.addEventListener("pointerdown", start => {
        if (start.button !== 0 || !start.isPrimary) return;
        start.preventDefault();
        handle.focus();
        active = index;
        refreshStops();
        const original = gradient;
        const width = track.getBoundingClientRect().width;
        const startPosition = gradient.stops[index].position;
        trackPointerDrag(start, move => {
          if (!handle.isConnected) return;
          const next = clampUnit(startPosition + (move.clientX - start.clientX) / width);
          updateStop({ position: Number(next.toFixed(3)) });
        }, end => {
          if (!end) { gradient = original; refreshStops(); }
          else if (handle.isConnected && gradient.stops[index].position !== startPosition) commit(gradient);
        });
      });
      track.append(handle);
      return handle;
    });
  };

  const addStop = (position: number) => {
    if (gradient.stops.length >= maxGradientStops) return;
    const rgba = gradientSampler(gradient)(position);
    active = gradient.stops.length;
    gradient = { ...gradient, stops: [...gradient.stops, { position, color: rgbHex(rgba), alpha: rgba[3] }] };
    replaceHandles();
    refreshStops();
    commit(gradient);
    handles[active].focus();
  };

  add.addEventListener("click", () => {
    const positions = [0, ...gradient.stops.map(stop => stop.position), 1].sort((a, b) => a - b);
    let widest = 0, midpoint = 0.5;
    for (let i = 1; i < positions.length; i++) {
      const span = positions[i] - positions[i - 1];
      if (span <= widest) continue;
      widest = span;
      midpoint = positions[i - 1] + span / 2;
    }
    addStop(Number(midpoint.toFixed(3)));
  });
  canvas.addEventListener("click", event => {
    if (!event.ctrlKey && !event.metaKey) return;
    const rect = canvas.getBoundingClientRect();
    addStop(Number(clampUnit((event.clientX - rect.left) / rect.width).toFixed(3)));
  });
  remove.addEventListener("click", () => {
    if (gradient.stops.length <= 1) return;
    const stops = gradient.stops.filter((_, index) => index !== active);
    active = Math.min(active, stops.length - 1);
    gradient = { ...gradient, stops };
    replaceHandles();
    refreshStops();
    commit(gradient);
    if (remove.disabled) handles[active].focus();
  });

  const refreshMode = () => {
    space.value = gradient.space;
    interpolation.replaceChildren(...(gradient.space === "RGB" ? rgbInterpolations : hueInterpolations).map(value => new Option(value)));
    interpolation.value = gradient.space === "RGB" ? gradient.interpolation : gradient.hue;
  };
  space.addEventListener("change", () => {
    gradient = { ...gradient, space: space.value as Gradient["space"] };
    refreshMode();
    drawRamp();
    commit(gradient);
  });
  interpolation.addEventListener("change", () => {
    gradient = gradient.space === "RGB"
      ? { ...gradient, interpolation: interpolation.value as Gradient["interpolation"] }
      : { ...gradient, hue: interpolation.value as Gradient["hue"] };
    drawRamp();
    commit(gradient);
  });
  stopPicker.addEventListener("change", () => { active = Number(stopPicker.value); refreshStops(); });
  const editNumber = (input: HTMLInputElement, key: "position" | "alpha") => {
    const apply = (value: number) => {
      if (!Number.isFinite(value)) { refreshStops(); return; }
      updateStop({ [key]: clampUnit(value) });
      commit(gradient);
    };
    input.addEventListener("change", () => apply(input.valueAsNumber));
    bindNumberDrag(input, 0.01, apply);
  };
  editNumber(position, "position");
  editNumber(alpha, "alpha");
  let colorDirty = false;
  color.addEventListener("input", () => {
    colorDirty = true;
    updateStop({ color: color.value });
  });
  color.addEventListener("change", () => {
    if (!colorDirty) updateStop({ color: color.value });
    colorDirty = false;
    commit(gradient);
  });
  refreshMode();
  replaceHandles();
  refreshStops();
  return field;
}
