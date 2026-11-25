import {
  clampUnit, colorCss, colorHex, hsvToRgb, isColorValue, parseHexColor, rgbFromHex, rgbHex, rgbToHsv,
  whiteColor, wrapHue, type ColorValue,
} from "./color-value";
import { trackPointerDrag } from "./node-number-input";

const recentKey = "nodesdevil-recent-colors";
const recentLimit = 8;
let recent: ColorValue[] = [];
try {
  const saved: unknown = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
  if (Array.isArray(saved)) recent = saved.filter(isColorValue).slice(0, recentLimit);
} catch { /* The picker also works without storage. */ }

function equalColor(a?: ColorValue, b?: ColorValue) {
  return a?.hex === b?.hex && a?.alpha === b?.alpha;
}

function colorButton(label: string, className: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  return button;
}

function slider(label: string, className: string) {
  const input = document.createElement("input");
  input.type = "range";
  input.className = className;
  input.min = "0";
  input.max = "1";
  input.step = "0.001";
  input.setAttribute("aria-label", label);
  return input;
}

export function colorField(initial: ColorValue | undefined, label: string, commit: (color: ColorValue | undefined) => void, optional = false, isSet = initial !== undefined) {
  let current = isSet ? initial : undefined;
  let working = initial ?? whiteColor;
  let [hue, saturation, brightness] = rgbToHsv(rgbFromHex(working.hex));

  const field = document.createElement("div");
  field.className = "nd-color-field";
  const trigger = colorButton(label, "nd-field nd-color-swatch");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  const popover = document.createElement("div");
  popover.className = "nd-color-popover";
  popover.popover = "auto";
  trigger.popoverTargetElement = popover;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", `${label} picker`);

  const surface = document.createElement("div");
  surface.className = "nd-color-surface";
  const wheel = colorButton("Color wheel", "nd-color-wheel");
  wheel.autofocus = true;
  wheel.setAttribute("aria-description", "Left and right adjust hue. Up and down adjust saturation.");
  const marker = document.createElement("span");
  marker.className = "nd-color-marker";
  wheel.append(marker);
  const level = slider("Brightness", "nd-color-range nd-color-level");
  level.setAttribute("aria-orientation", "vertical");
  surface.append(wheel, level);

  const alpha = slider("Alpha", "nd-color-range nd-color-alpha");
  const alphaLabel = document.createElement("label");
  alphaLabel.className = "nd-color-alpha-row";
  const percentage = document.createElement("span");
  percentage.setAttribute("aria-hidden", "true");
  alphaLabel.append("Alpha", alpha, percentage);

  const hexLabel = document.createElement("label");
  hexLabel.className = "nd-color-hex-row";
  const hex = document.createElement("input");
  hex.className = "nd-field";
  hex.spellcheck = false;
  hex.autocomplete = "off";
  hex.maxLength = 9;
  hex.title = "Hex RGB or RGBA";
  hexLabel.append("Hex", hex);

  const recentLabel = document.createElement("span");
  recentLabel.textContent = "Recent colors";
  const swatches = document.createElement("div");
  swatches.className = "nd-color-recents";
  const clear = colorButton("Clear color override", "nd-button nd-color-clear");
  clear.textContent = "Clear color";
  popover.append(surface, alphaLabel, hexLabel, recentLabel, swatches);
  if (optional) popover.append(clear);
  field.append(trigger, popover);

  const refresh = () => {
    trigger.classList.toggle("nd-color-unset", !current);
    trigger.style.setProperty("--nd-swatch", current ? colorCss(working) : "transparent");
    trigger.title = current ? colorHex(working) : isSet ? "Existing color" : "Inherit color";
    clear.disabled = !isSet;
    const angle = hue * 2 * Math.PI;
    marker.style.left = `${50 + Math.cos(angle) * saturation * 50}%`;
    marker.style.top = `${50 + Math.sin(angle) * saturation * 50}%`;
    wheel.style.setProperty("--nd-wheel-shade", String(1 - brightness));
    level.style.setProperty("--nd-swatch", rgbHex(hsvToRgb(hue, saturation, 1)));
    level.value = String(brightness);
    alpha.value = String(working.alpha);
    alpha.style.setProperty("--nd-swatch", working.hex);
    percentage.textContent = `${Number((working.alpha * 100).toFixed(1))}%`;
    alpha.setAttribute("aria-valuetext", percentage.textContent);
    hex.value = colorHex(working);
    hex.removeAttribute("aria-invalid");
  };

  const refreshRecent = () => {
    swatches.replaceChildren(...recent.map(value => {
      const swatch = colorButton(`Use ${colorHex(value)}`, "nd-color-swatch");
      swatch.title = colorHex(value);
      swatch.style.setProperty("--nd-swatch", colorCss(value));
      swatch.addEventListener("click", () => {
        working = value;
        [hue, saturation, brightness] = rgbToHsv(rgbFromHex(value.hex));
        apply();
        swatches.querySelector<HTMLButtonElement>("button")?.focus();
      });
      return swatch;
    }));
    if (!recent.length) swatches.textContent = "—";
  };

  const apply = () => {
    if (!isSet || !equalColor(current, working)) {
      current = working;
      isSet = true;
      commit(working);
      recent = [working, ...recent.filter(value => !equalColor(value, working))].slice(0, recentLimit);
      try { localStorage.setItem(recentKey, JSON.stringify(recent)); }
      catch { /* Recent colors are still available in this tab. */ }
      refreshRecent();
    }
    refresh();
  };

  const updateRgb = () => {
    working = { ...working, hex: rgbHex(hsvToRgb(hue, saturation, brightness)) };
    refresh();
  };

  wheel.addEventListener("pointerdown", start => {
    if (start.button !== 0 || !start.isPrimary) return;
    start.preventDefault();
    wheel.focus({ preventScroll: true });
    const rect = wheel.getBoundingClientRect();
    const original = { working, hue, saturation };
    const pick = (event: PointerEvent) => {
      const x = (event.clientX - rect.left) / rect.width * 2 - 1;
      const y = (event.clientY - rect.top) / rect.height * 2 - 1;
      saturation = clampUnit(Math.hypot(x, y));
      if (saturation > 0) hue = wrapHue(Math.atan2(y, x) / (Math.PI * 2));
      updateRgb();
    };
    pick(start);
    trackPointerDrag(start, pick, end => {
      if (end && popover.matches(":popover-open")) apply();
      else { ({ working, hue, saturation } = original); refresh(); }
    });
  });
  wheel.addEventListener("keydown", event => {
    const hueStep = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
    const saturationStep = Number(event.key === "ArrowUp") - Number(event.key === "ArrowDown");
    if (!(hueStep || saturationStep)) return;
    event.preventDefault();
    hue = wrapHue(hue + hueStep * (event.shiftKey ? 0.05 : 0.01));
    saturation = clampUnit(saturation + saturationStep * (event.shiftKey ? 0.1 : 0.02));
    updateRgb();
    apply();
  });
  level.addEventListener("input", () => { brightness = level.valueAsNumber; updateRgb(); });
  alpha.addEventListener("input", () => { working = { ...working, alpha: alpha.valueAsNumber }; refresh(); });
  level.addEventListener("change", apply);
  alpha.addEventListener("change", apply);
  hex.addEventListener("input", () => hex.removeAttribute("aria-invalid"));
  hex.addEventListener("change", () => {
    const value = parseHexColor(hex.value, working.alpha);
    if (!value) { hex.setAttribute("aria-invalid", "true"); return; }
    working = value;
    [hue, saturation, brightness] = rgbToHsv(rgbFromHex(value.hex));
    apply();
  });
  hex.addEventListener("keydown", event => { if (event.key === "Enter") hex.blur(); });
  clear.addEventListener("click", () => {
    current = undefined;
    isSet = false;
    working = whiteColor;
    [hue, saturation, brightness] = rgbToHsv(rgbFromHex(working.hex));
    refresh();
    commit(undefined);
    popover.hidePopover();
    trigger.focus();
  });

  const position = () => {
    const gap = 6;
    const bounds = trigger.getBoundingClientRect();
    const width = popover.offsetWidth, height = popover.offsetHeight;
    const maxLeft = window.innerWidth - width - gap;
    const maxTop = window.innerHeight - height - gap;
    const above = bounds.bottom + gap > maxTop && bounds.top - height - gap >= gap;
    popover.style.left = `${Math.max(gap, Math.min(bounds.right - width, maxLeft))}px`;
    popover.style.top = `${Math.max(gap, Math.min(above ? bounds.top - height - gap : bounds.bottom + gap, maxTop))}px`;
  };
  popover.addEventListener("beforetoggle", event => {
    if (event.newState !== "open") return;
    refresh();
    refreshRecent();
    popover.style.left = "0px";
    popover.style.top = "0px";
  });
  popover.addEventListener("toggle", () => {
    const open = popover.matches(":popover-open");
    trigger.setAttribute("aria-expanded", String(open));
    if (open) position();
  });
  refresh();
  return field;
}
