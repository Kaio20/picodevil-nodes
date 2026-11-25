const tooltipTrigger = "[data-tooltip], select.nd-field";
const tooltipId = "nd-tooltip";

function tooltipText(trigger: HTMLElement) {
  if (!(trigger instanceof HTMLSelectElement)) return trigger.dataset.tooltip;
  const option = trigger.selectedOptions[0];
  if (option && (option.value || option.dataset.tooltip)) {
    return [option.label, option.dataset.tooltip].filter(Boolean).join("\n");
  }
}

export function setupNodeTooltip(host: HTMLElement) {
  const tooltip = document.createElement("div");
  tooltip.id = tooltipId;
  tooltip.className = "nd-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  const heading = document.createElement("strong");
  const description = document.createElement("div");
  description.className = "nd-tooltip-description";
  tooltip.append(heading, description);
  host.append(tooltip);

  let trigger: HTMLElement | undefined;
  let pointer: { x: number; y: number } | undefined;
  let timer: number | undefined;
  let width = 0;
  let height = 0;
  let previousDescription: string | null = null;

  function dismiss() {
    window.clearTimeout(timer);
    if (trigger && !tooltip.hidden) {
      if (previousDescription === null) trigger.removeAttribute("aria-describedby");
      else trigger.setAttribute("aria-describedby", previousDescription);
    }
    tooltip.hidden = true;
    if (tooltip.parentElement !== host) host.append(tooltip);
    trigger = pointer = undefined;
  }

  function position(x: number, above: number, below: number) {
    const margin = 8;
    const gap = 12;
    const left = Math.max(margin, Math.min(x + gap, host.clientWidth - width - margin));
    const top = above - height - gap >= margin
      ? above - height - gap
      : Math.max(margin, Math.min(below + gap, innerHeight - height - margin));
    tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function show() {
    if (!trigger || !host.contains(trigger) || host.hidden) return dismiss();
    const text = tooltipText(trigger);
    if (!text) return dismiss();
    const [label, ...details] = text.split("\n");
    heading.textContent = label;
    description.textContent = details.join("\n");
    if (tooltip.hidden) {
      trigger.closest(".nd-catalog-menu[popover]")?.append(tooltip);
      previousDescription = trigger.getAttribute("aria-describedby");
      tooltip.hidden = false;
      trigger.setAttribute("aria-describedby", previousDescription ? `${previousDescription} ${tooltipId}` : tooltipId);
    }
    ({ width, height } = tooltip.getBoundingClientRect());
    if (pointer) position(pointer.x, pointer.y, pointer.y);
    else {
      const rect = trigger.getBoundingClientRect();
      position(rect.left, rect.top, rect.bottom);
    }
  }

  host.addEventListener("pointermove", event => {
    if (event.pointerType === "touch" || event.buttons) return;
    const next = (event.target as Element).closest<HTMLElement>(tooltipTrigger);
    if (next !== trigger || !pointer) {
      dismiss();
      if (!next || !tooltipText(next)) return;
      trigger = next;
      timer = window.setTimeout(show, 400);
    }
    pointer = { x: event.clientX, y: event.clientY };
    if (!tooltip.hidden) position(pointer.x, pointer.y, pointer.y);
  });
  host.addEventListener("pointerleave", () => { if (pointer) dismiss(); });
  host.addEventListener("pointerdown", dismiss, { capture: true });
  host.addEventListener("click", dismiss);
  host.addEventListener("wheel", dismiss, { capture: true, passive: true });
  host.addEventListener("focusin", event => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches(tooltipTrigger) || !event.target.matches(":focus-visible")) return;
    dismiss();
    trigger = event.target;
    show();
  });
  host.addEventListener("focusout", event => { if (event.target === trigger) dismiss(); });
  host.addEventListener("input", event => { if (event.target === trigger && !tooltip.hidden) show(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") dismiss(); });
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);

  return dismiss;
}
