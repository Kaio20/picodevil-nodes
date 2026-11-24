import type { NodeDrop } from "./node-graph";

type Receiver = (drop: NodeDrop | null, x: number, y: number, commit: boolean) => boolean;
let receiver: Receiver | undefined;

export function setSidebarDropReceiver(next: Receiver) { receiver = next; }
export function sidebarDrop(drop: NodeDrop | null, x = 0, y = 0, commit = false): boolean {
  return receiver?.(drop, x, y, commit) ?? false;
}

/** Discard the release click from this drag, while letting the next gesture through. */
export function ignoreDropClick() {
  const controller = new AbortController();
  const options = { capture: true, once: true, signal: controller.signal };
  const cancel = () => controller.abort();
  document.addEventListener("pointerdown", cancel, options);
  document.addEventListener("keydown", cancel, options);
  document.addEventListener("click", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  }, options);
  setTimeout(cancel, 350);
}

/** Reference and audio use the same graph drop targets as media thumbnails. */
export function attachNodeDrag(element: HTMLElement, drop: NodeDrop) {
  element.draggable = false;
  element.classList.add("node-draggable");
  element.addEventListener("pointerdown", start => {
    if (!document.body.classList.contains("nd-mode") || start.button !== 0 || !start.isPrimary) return;
    const capture = new AbortController();
    let moved = false;
    const options = { signal: capture.signal };
    const cancel = () => { capture.abort(); sidebarDrop(null); };
    document.addEventListener("pointermove", event => {
      if (event.pointerId !== start.pointerId) return;
      moved ||= Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 6;
      if (moved) sidebarDrop(drop, event.clientX, event.clientY);
    }, options);
    document.addEventListener("pointerup", event => {
      if (event.pointerId !== start.pointerId) return;
      if (moved) {
        sidebarDrop(drop, event.clientX, event.clientY, true);
        ignoreDropClick();
      }
      cancel();
    }, options);
    document.addEventListener("pointercancel", cancel, options);
    document.addEventListener("keydown", event => { if (event.key === "Escape") cancel(); }, options);
  });
}
