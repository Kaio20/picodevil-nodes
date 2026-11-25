import { type MediaEntry } from "./media-registry";
import { phosphorIcon } from "./icons";

/**
 * Thumbnail cell helpers, shared by the videos tab's two modes: the grid ("view"
 * mode) builds one cell per entry; the row list ("edit" mode) reuses `insertName`
 * for its clickable thumbnail. Clicking either inserts the clip's short name (the
 * token you'd type inside `s(...)`) at the editor cursor.
 */

/** Insert a clip's short name at the editor cursor. */
export function insertName(name: string) {
  window.pdInsertAtCursor?.(name);
}

/** Signature that, when unchanged, lets a cell's DOM be reused across re-renders. */
export function cellKey(e: MediaEntry): string {
  return `${e.name} ${e.thumbnail ?? ""} ${e.type} ${e.unavailable ? 1 : 0}`;
}

export function makeThumbCell(
  entry: MediaEntry,
  onPick: (name: string) => void,
  options?: { label?: string; lazy?: boolean },
): HTMLButtonElement {
  const cell = document.createElement("button");
  cell.className = "thumb-cell";
  cell.type = "button";
  cell.dataset.flipKey = entry.name; // paired with the row's thumb for the view⇄edit transition
  cell.title = `Insert "${entry.name}"`;

  if (entry.thumbnail) {
    const img = document.createElement("img");
    if (options?.lazy) img.loading = "lazy";
    img.src = entry.thumbnail;
    img.alt = entry.name;
    img.draggable = false;
    cell.appendChild(img);
  } else {
    // No thumbnail: streams never have one, unavailable = failed to decode,
    // otherwise it's still generating. Name is still shown + clickable.
    const ph = document.createElement("span");
    ph.className = "thumb-placeholder";
    ph.append(phosphorIcon(entry.type === "stream" ? "broadcast" : entry.unavailable ? "warning" : "dots-three"));
    cell.appendChild(ph);
  }

  // Bottom bar holds the name and (when present) the progress badge as flex
  // siblings, so the label yields exactly the space the badge needs — no maths.
  const bar = document.createElement("div");
  bar.className = "thumb-bar";
  const label = document.createElement("span");
  label.className = "thumb-label";
  label.textContent = options?.label ?? entry.name;
  bar.appendChild(label);
  cell.appendChild(bar);

  cell.addEventListener("click", () => onPick(entry.name));
  return cell;
}
