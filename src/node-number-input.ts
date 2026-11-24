export function trackPointerDrag(start: PointerEvent, move: (event: PointerEvent) => void, finish: (event?: PointerEvent) => void): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const end = (event?: PointerEvent) => {
    controller.abort();
    finish(event);
  };
  document.addEventListener("pointermove", event => { if (event.pointerId === start.pointerId) move(event); }, { signal });
  document.addEventListener("pointerup", event => { if (event.pointerId === start.pointerId) end(event); }, { signal });
  document.addEventListener("pointercancel", event => { if (event.pointerId === start.pointerId) end(); }, { signal });
  document.addEventListener("keydown", event => { if (event.key === "Escape") end(); }, { signal });
  window.addEventListener("blur", () => end(), { signal });
  return () => end();
}

export function bindNumberDrag(
  input: HTMLInputElement,
  dragStep: number | undefined,
  commit: (value: number) => void,
  track: (...args: Parameters<typeof trackPointerDrag>) => void = trackPointerDrag,
) {
  input.dataset.tooltip = "Drag right or up to increase, left or down to decrease";
  input.addEventListener("dragstart", event => event.preventDefault());
  input.addEventListener("pointerdown", start => {
    if (start.button !== 0 || !start.isPrimary) return;
    const original = input.value;
    const initial = input.valueAsNumber || 0;
    const step = dragStep ?? (Math.abs(initial) >= 100 ? 1 : 0.01);
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    const pixelsPerStep = 12;
    let previous = start;
    let distance = 0;
    let dragStartedAt: number | undefined;
    track(start, move => {
      if (!input.isConnected) return;
      const dx = move.clientX - previous.clientX;
      const dy = move.clientY - previous.clientY;
      previous = move;
      // Follow the stronger axis on each move so users can switch directions mid-drag.
      const movement = Math.abs(dx) >= Math.abs(dy) ? dx : -dy;
      const elapsed = dragStartedAt === undefined ? 0 : move.timeStamp - dragStartedAt;
      const sensitivity = 1 + Math.min(elapsed / 600, 2);
      distance += movement * sensitivity;
      if (dragStartedAt === undefined) {
        if (Math.abs(distance) < 4 || input.value !== original) return;
        dragStartedAt = move.timeStamp;
        input.setPointerCapture(start.pointerId);
        input.classList.add("nd-number-dragging");
      }
      const steps = Math.trunc(distance / pixelsPerStep);
      const value = Number((initial + steps * step).toPrecision(15));
      if (Number.isFinite(value)) input.value = steps ? String(Math.max(min, Math.min(max, value))) : original;
    }, end => {
      if (dragStartedAt === undefined) return;
      input.classList.remove("nd-number-dragging");
      if (input.hasPointerCapture(start.pointerId)) input.releasePointerCapture(start.pointerId);
      if (!end) input.value = original;
      else if (input.isConnected && input.value !== original) commit(input.valueAsNumber);
    });
  });
}
