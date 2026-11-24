import type { NodeDrop } from "./node-graph";

type PrepareDrop = () => NodeDrop;
export type SidebarDropOptions = { prepare?: PrepareDrop; hasThumbnail?: boolean };
type Receiver = (drop: NodeDrop | null, x: number, y: number, commit: boolean, options?: SidebarDropOptions) => boolean;
let receiver: Receiver | undefined;

export function setSidebarDropReceiver(next: Receiver) { receiver = next; }
export function sidebarDrop(drop: NodeDrop | null, x = 0, y = 0, commit = false, options?: SidebarDropOptions): boolean {
  return receiver?.(drop, x, y, commit, options) ?? false;
}

export function liftMediaThumbnail(thumbnail: HTMLElement, startX: number, startY: number) {
  const rect = thumbnail.getBoundingClientRect();
  const offsetX = startX - rect.left;
  const offsetY = startY - rect.top;
  const clone = thumbnail.cloneNode(true) as HTMLElement;
  clone.classList.add("drag-clone");
  clone.classList.toggle("texture-drag-clone", Boolean(thumbnail.closest("#tab-textures")));
  clone.inert = true;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.transform = "";
  clone.style.transition = "";
  const move = (x: number, y: number) => {
    clone.style.left = `${x - offsetX}px`;
    clone.style.top = `${y - offsetY}px`;
  };
  move(startX, startY);
  document.body.append(clone);
  return { move, remove: () => clone.remove() };
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

/** Drag sidebar entries that do not support reordering into the graph. */
export function attachNodeDrag(element: HTMLElement, drop: NodeDrop, prepare?: PrepareDrop) {
  element.draggable = false;
  element.classList.add("node-draggable");
  element.addEventListener("pointerdown", start => {
    if (!document.body.classList.contains("nd-mode") || start.button !== 0 || !start.isPrimary) return;
    const capture = new AbortController();
    let moved = false;
    let preview: ReturnType<typeof liftMediaThumbnail> | undefined;
    const options = { signal: capture.signal };
    const cancel = () => {
      capture.abort();
      preview?.remove();
      sidebarDrop(null);
      if (moved) ignoreDropClick();
    };
    document.addEventListener("pointermove", event => {
      if (event.pointerId !== start.pointerId) return;
      if (!moved) {
        if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) <= 6) return;
        moved = true;
        if (element.matches(".thumb-cell")) preview = liftMediaThumbnail(element, start.clientX, start.clientY);
      }
      preview?.move(event.clientX, event.clientY);
      sidebarDrop(drop, event.clientX, event.clientY, false, { hasThumbnail: Boolean(preview) });
    }, options);
    document.addEventListener("pointerup", event => {
      if (event.pointerId !== start.pointerId) return;
      if (moved) sidebarDrop(drop, event.clientX, event.clientY, true, { prepare });
      cancel();
    }, options);
    document.addEventListener("pointercancel", event => { if (event.pointerId === start.pointerId) cancel(); }, options);
    document.addEventListener("keydown", event => { if (event.key === "Escape") cancel(); }, options);
    window.addEventListener("blur", cancel, options);
  });
}
