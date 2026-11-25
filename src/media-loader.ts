import {
  getAllEntries, addMedia, removeMedia, renameMedia, updateUrl, updateEntry,
  isYouTubeUrl, downloadYouTube, exportAll, importAll, clearAll, setOnChange,
  uploadToServer, addFromServer, missingFromServer, guessTypeFromFile, isTexture, moveMediaBefore,
  type MediaCollection, type MediaEntry, type SourceItem,
} from "./media-registry";
import { getServerUrl, getServerStatus, subscribe as subscribeServer } from "./server-config";
import { createServerSettingsButton } from "./server-settings-ui";
import {
  startWebcam, startScreenCapture, stopStream, removeStream,
  isStreamActive, setStreamOnChange, reconnectStreams,
} from "./stream-manager";
import { makeThumbCell, cellKey, insertName } from "./thumbs";
import { ignoreDropClick, liftMediaThumbnail, sidebarDrop } from "./node-sidebar-drag";
import { makeTextureCatalog } from "./texture-catalog";
import type { NodeDrop } from "./node-graph";
import { phosphorIcon } from "./icons";

type ViewMode = "edit" | "view";
const FLIP_MS = 300;
let render = () => {};

function flipEnabled(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Snapshot a pane as a fixed-position clone over its current spot and fade it
 *  out — so its text eases away instead of vanishing when the real pane is
 *  hidden. Thumbnails are hidden on the clone (the real flying/incoming ones
 *  cover that area). Cleans up on transitionend, with a fallback. */
function fadeOutPane(pane: HTMLElement) {
  const rect = pane.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const clone = pane.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-list");
  clone.removeAttribute("data-grid");
  clone.classList.add("pd-fade-out-clone");
  clone.style.left = `${rect.left}px`;
  clone.style.top = `${rect.top}px`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.querySelectorAll<HTMLElement>(".vid-thumb, .thumb-cell > img").forEach(t => { t.style.visibility = "hidden"; });
  // cloneNode copies input attributes, not live values — mirror name/url over.
  const src = pane.querySelectorAll("input");
  const dst = clone.querySelectorAll("input");
  src.forEach((inp, i) => { if (dst[i]) dst[i].value = inp.value; });
  document.body.appendChild(clone);
  clone.scrollTop = pane.scrollTop; // align rows with the original
  requestAnimationFrame(() => { clone.style.opacity = "0"; });
  const remove = () => clone.remove();
  clone.addEventListener("transitionend", remove);
  setTimeout(remove, 4000);
}

/** Screen rects of every laid-out thumbnail (grid cell / row thumb), keyed by
 *  flip-key. Only the visible pane has non-zero rects, so this captures it. */
function measureFlipRects(container: HTMLElement): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>();
  container.querySelectorAll<HTMLElement>("[data-flip-key]").forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width && r.height) m.set(el.dataset.flipKey!, r);
  });
  return m;
}

/** Curated starter media, hosted on the static CDN (sources.json import/export shape). */
const DEFAULTS_URL = "https://videoclip.picodevil.com/sources.json";
/** The fetched defaults list, or null until the one-shot fetch resolves (or fails). */
let defaultSources: SourceItem[] | null = null;
let defaultSourcesRequest: Promise<SourceItem[]> | undefined;

export async function loadExampleMedia(names: readonly string[]) {
  if (names.length === 0) return;
  const sources = defaultSources ?? await defaultSourcesRequest ?? [];
  const present = new Set(getAllEntries().map(entry => entry.name));
  const wanted = new Set(names);
  addFromServer(sources.filter(item => item.name && wanted.has(item.name) && !present.has(item.name)), "videos");
}

/**
 * Whether to auto-populate the registry with the CDN defaults once they're
 * fetched. True only on a genuinely fresh session (no saved URL state) that
 * hasn't loaded anything yet. A returning user who deliberately cleared their
 * media still carries a URL hash, so their session is *not* fresh and we leave
 * it untouched.
 */
export function shouldAutoloadDefaults(isFreshSession: boolean, entryCount: number): boolean {
  return isFreshSession && entryCount === 0;
}

export function setupMediaLoader(videos: HTMLElement, isFreshSession = false, textures?: HTMLElement | null) {
  const renderVideos = createMediaTab(videos, "videos");
  const renderTextures = textures && createMediaTab(textures, "textures");
  render = () => {
    renderVideos();
    renderTextures?.();
  };
  setOnChange(render);
  setStreamOnChange(render);
  // Re-render when the server connection status changes so the "Load all"
  // footer button appears/disappears in step with the connection.
  subscribeServer(render);
  render();

  // Fetch the defaults bundle once. On a fresh session we pull it in
  // automatically so a first-time visitor lands with media ready (same effect
  // as clicking "Defaults", which then self-hides). For a returning user it
  // just enables the "Defaults" button, shown only when it contains media not
  // already in the list — so a failed/blocked fetch loads nothing and the
  // button stays hidden.
  defaultSourcesRequest = fetch(DEFAULTS_URL)
    .then(res => res.ok ? res.json() : null)
    .then((items: unknown) => Array.isArray(items) ? items as SourceItem[] : [])
    .catch(() => []);
  void defaultSourcesRequest.then(items => {
      if (items.length === 0) return;
      defaultSources = items;
      if (shouldAutoloadDefaults(isFreshSession, getAllEntries("videos").length)) {
        addFromServer(defaultSources, "videos");
      }
      render();
    });

  // Reconnect persisted webcam streams (screen captures need manual reconnect)
  reconnectStreams().then(render);
}

function createMediaTab(container: HTMLElement, collection: MediaCollection) {
  const viewModeKey = "picodevil-" + collection + "-view";
  const gridScrollKey = "picodevil-" + collection + "-scroll";
  let viewMode: ViewMode = localStorage.getItem(viewModeKey) === "edit" ? "edit" : "view";
  const catalog = collection === "textures" ? makeTextureCatalog(render, showToast) : undefined;
  const serverSettings = createServerSettingsButton().el;

  // Persisted scroll offset of the grid ("view") pane — restored across mode
  // toggles and reloads. `restoreGridScroll` gates a one-shot restore on the next
  // view render so ordinary re-renders (progress ticks, etc.) don't fight the user.
  let gridScroll = Number(localStorage.getItem(gridScrollKey)) || 0;
  let restoreGridScroll = true;
  let gridScrollTimer: ReturnType<typeof setTimeout> | undefined;

  function saveGridScroll() {
    clearTimeout(gridScrollTimer);
    gridScrollTimer = setTimeout(() => {
      try { localStorage.setItem(gridScrollKey, String(Math.round(gridScroll))); } catch { /* storage disabled */ }
    }, 200);
  }

  let flipping = false;
  let flipToken = 0;

  function setViewMode(mode: ViewMode) {
    if (mode === viewMode) return;
    flipping = false; // let a re-toggle mid-animation swap the panes
    const first = flipEnabled() ? measureFlipRects(container) : null; // outgoing thumbnail positions
    // Going list → thumbs, fade the outgoing list text out (rather than snapping to
    // transparent when the pane is hidden). The grid has no separate text chrome
    // (the label rides the flying cell), so only this direction needs it.
    if (first && mode === "view") {
      const list = container.querySelector<HTMLElement>("[data-list]");
      if (list) fadeOutPane(list);
    }
    viewMode = mode;
    try { localStorage.setItem(viewModeKey, mode); } catch { /* storage disabled */ }
    if (mode === "view") restoreGridScroll = true; // re-restore where they left off
    render(); // swaps the panes
    if (first?.size) playFlip(first);
  }

  function playFlip(first: Map<string, DOMRect>) {
    const pane = container.querySelector<HTMLElement>(viewMode === "view" ? "[data-grid]" : "[data-list]");
    const view = pane?.getBoundingClientRect();
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    const anims: HTMLElement[] = [];
    container.querySelectorAll<HTMLElement>("[data-flip-key]").forEach(el => {
      const f = first.get(el.dataset.flipKey!);
      if (!f) return;
      const l = el.getBoundingClientRect();
      if (!l.width || !l.height) return;                   // the now-hidden old pane
      if (view && !hit(f, view) && !hit(l, view)) return;  // both off-screen — skip
      const dx = f.left - l.left, dy = f.top - l.top;
      const sx = f.width / l.width, sy = f.height / l.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02) return;
      el.style.transition = "none";
      el.style.transformOrigin = "top left";
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      anims.push(el);
    });
    if (!anims.length) return;
    flipping = true; // pause render() so a playback save() can't reconcile mid-flight
    pane?.classList.add("pd-chrome-in"); // fade the incoming pane's text/labels in
    const token = ++flipToken;

    // Release on the NEXT frame, not after a layout read: a composited transform
    // isn't committed by reading offsetWidth, so inverting-then-clearing in the same
    // frame coalesces into a no-op and the motion collapses to a jump. rAF lets the
    // browser paint the inverted (First) state once, then animate it to identity.
    requestAnimationFrame(() => {
      for (const el of anims) {
        el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`;
        el.style.transform = "";
      }
    });

    // Clean up when the motion actually finishes (transitionend), not on a fixed
    // timer — so cleanup can never clear a still-running transform and snap it,
    // whatever the playback speed (e.g. slow-mo in the Animations inspector). The
    // fallback only covers a genuinely missed transitionend.
    const done = () => {
      clearTimeout(fallback);
      anims[0].removeEventListener("transitionend", done);
      if (token !== flipToken) return; // superseded by a newer toggle — leave it be
      for (const el of anims) { el.style.transition = ""; el.style.transformOrigin = ""; el.style.transform = ""; }
      pane?.classList.remove("pd-chrome-in");
      flipping = false;
      render(); // catch up on anything deferred during the flight
    };
    anims[0].addEventListener("transitionend", done);
    const fallback = setTimeout(done, 4000);
  }

  function render() {
    // Don't reflow the panes mid-drag or mid-flip: a save() from playback (durations
    // loading, thumbnails finishing, progress ticks) would otherwise reconcile an
    // animating element (snapping it to its final spot) and break the motion. Both
    // finishDrag() and the flip's cleanup re-render once the animation ends.
    if (drag?.active || flipping) return;

    // First render: build the persistent structure (add bar + both view panes).
    // These are never torn down so scroll positions and the add bar's input value
    // survive subsequent renders; only the active pane is shown.
    if (!container.querySelector("[data-add-bar]")) {
      container.appendChild(makeAddBar());
      if (catalog) container.append(catalog.controls, catalog.grid);
    }
    if (!container.querySelector("[data-list]")) {
      const list = document.createElement("div");
      list.dataset.list = "1";
      list.className = "vid-list";
      container.appendChild(list);
    }
    if (!container.querySelector("[data-grid]")) {
      const grid = document.createElement("div");
      grid.dataset.grid = "1";
      grid.className = "thumbs-grid";
      // Persist scroll as the user scrolls (skip the programmatic restore below,
      // which would otherwise re-save a possibly-clamped value).
      grid.addEventListener("scroll", () => {
        if (restoreGridScroll) return;
        gridScroll = grid.scrollTop;
        saveGridScroll();
      }, { passive: true });
      container.appendChild(grid);
    }

    const list = container.querySelector<HTMLElement>("[data-list]")!;
    const grid = container.querySelector<HTMLElement>("[data-grid]")!;
    const editing = viewMode === "edit";
    const browsing = catalog?.browsing();
    list.style.display = !browsing && editing ? "" : "none";
    grid.style.display = !browsing && !editing ? "" : "none";

    // Reconcile only the visible pane in place — no scroll position lost. The
    // hidden pane is left stale and refreshed the next time it's shown.
    const entries = getAllEntries(collection);
    if (!browsing && editing) {
      reconcileList(list, entries);
    } else if (!browsing) {
      reconcileGrid(grid, entries);
      // One-shot restore of the persisted scroll, once entries exist (rows are
      // fixed-height, so the grid's full height is known as soon as they're added).
      if (restoreGridScroll && entries.length > 0 && container.classList.contains("active")) {
        grid.scrollTop = gridScroll;
        restoreGridScroll = false;
      }
    }

    // Footer has conditional buttons (Defaults, Load all, server status) and lives
    // outside the scrollable area, so it's cheap and safe to rebuild each time.
    const oldFooter = container.querySelector<HTMLElement>("[data-footer]");
    const newFooter = makeFooter();
    newFooter.dataset.footer = "1";
    if (oldFooter) {
      container.replaceChild(newFooter, oldFooter);
    } else {
      container.appendChild(newFooter);
    }
  }

  function addUrl(url: string) {
    const entry = addMedia(url, undefined, undefined, collection);
    if (isYouTubeUrl(url)) downloadYouTube(entry.name);
    catalog?.showLibrary();
  }

  function addFiles(files: FileList) {
    if (files.length === 0) return;
    for (const file of files) {
      const type = guessTypeFromFile(file);
      const name = file.name.replace(/\.[^.]+$/, "");
      const entry = addMedia(URL.createObjectURL(file), name, type, collection);
      // /upload transcodes to MP4. Keep local textures as images to preserve transparency.
      if (collection === "textures" && type === "image") continue;
      if (getServerUrl() && getServerStatus() !== "error") {
        uploadToServer(entry.name, file).catch(err => {
          if (/too large/i.test(err?.message ?? "")) showToast(err.message);
        });
      }
    }
    catalog?.showLibrary();
  }

  function importMedia(text: string) {
    importAll(text, collection);
    catalog?.showLibrary();
  }

  function makeAddBar(): HTMLElement {
    const addBar = document.createElement("div");
    addBar.dataset.addBar = "1";
    addBar.className = "add-bar";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "paste URL to add...";
    input.className = "pd-input";

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    addBtn.className = "pd-btn";
    addBtn.addEventListener("click", () => {
      const url = input.value.trim();
      if (!url) return;
      addUrl(url);
      input.value = "";
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn.click();
    });

    const camBtn = document.createElement("button");
    camBtn.textContent = "Webcam";
    camBtn.className = "pd-btn";
    camBtn.addEventListener("click", async () => {
      try {
        await startWebcam(undefined, undefined, collection);
        catalog?.showLibrary();
        render();
      } catch (e: any) {
        showToast(e.message ?? "Webcam failed");
      }
    });

    const screenBtn = document.createElement("button");
    screenBtn.textContent = "Screen";
    screenBtn.className = "pd-btn";
    screenBtn.addEventListener("click", async () => {
      try {
        await startScreenCapture(undefined, collection);
        catalog?.showLibrary();
        render();
      } catch (e: any) {
        showToast(e.message ?? "Screen capture failed");
      }
    });

    addBar.appendChild(input);
    addBar.appendChild(addBtn);
    if (catalog) {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*,video/*,.mkv,.avi";
      fileInput.multiple = true;
      fileInput.hidden = true;
      fileInput.addEventListener("change", () => {
        if (fileInput.files) addFiles(fileInput.files);
        fileInput.value = "";
      });
      const files = document.createElement("button");
      files.type = "button";
      files.className = "pd-btn";
      files.textContent = "Files";
      files.title = "Open local media files. Local images are available for this session.";
      files.addEventListener("click", () => fileInput.click());
      addBar.append(files, fileInput);
    }
    addBar.appendChild(camBtn);
    addBar.appendChild(screenBtn);
    return addBar;
  }

  function makeFooter(): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "vid-footer";

    const leftGroup = document.createElement("div");
    leftGroup.className = "vid-footer-left";
    footer.appendChild(leftGroup);

    const rightGroup = document.createElement("div");
    rightGroup.className = "vid-footer-right";
    footer.appendChild(rightGroup);

    // Mode toggle — icon shows the mode you'd switch *to* (grid vs edit).
    const goEdit = viewMode === "view";
    const toggle = makeFooterBtn("", () => {
      catalog?.showLibrary();
      setViewMode(goEdit ? "edit" : "view");
    });
    toggle.classList.add("vid-view-toggle");
    toggle.append(phosphorIcon(goEdit ? "pencil-simple-line" : "grid-four"));
    toggle.title = goEdit ? "Switch to edit view" : "Switch to grid view";
    toggle.setAttribute("aria-label", toggle.title);
    leftGroup.appendChild(toggle);

    leftGroup.appendChild(makeFooterBtn("Export", () => {
      navigator.clipboard.writeText(exportAll(collection)).then(
        () => showToast("Copied to clipboard"),
        () => showToast("Copy failed"),
      );
    }));

    leftGroup.appendChild(makeFooterBtn("Import", () => {
      navigator.clipboard.readText().then((text) => {
        try {
          importMedia(text);
          showToast("Imported");
        } catch {
          showToast("Invalid JSON");
        }
      }).catch(() => showToast("Clipboard access denied"));
    }));

    const clearBtn = makeFooterBtn("Clear", () => {
      clearBtn.textContent = "Confirm?";
      clearBtn.style.color = "#f88";
      const timeout = setTimeout(() => {
        clearBtn.textContent = "Clear";
        clearBtn.style.color = ""; // back to the class colour (+ restores :hover)
      }, 2000);
      clearBtn.addEventListener("click", () => {
        clearTimeout(timeout);
        clearAll(collection);
      }, { once: true });
    });
    leftGroup.appendChild(clearBtn);

    // "Defaults" (left group) — only when the fetched defaults contain media not
    // already loaded. Disappears once everything's been pulled in.
    const missingDefaults = collection === "videos" && defaultSources ? missingFromServer(defaultSources, collection) : [];
    if (missingDefaults.length > 0) {
      leftGroup.appendChild(makeFooterBtn("Defaults", () => {
        const added = addFromServer(missingDefaults, collection);
        showToast(`Added ${added} default${added === 1 ? "" : "s"}`);
      }));
    }

    // "Load all" (right group) — only when we have a live connection. Pulls
    // everything the server can currently serve via GET /list.
    if (getServerUrl() && getServerStatus() === "ok") {
      const addServerBtn = makeFooterBtn("Load all", async () => {
        const base = getServerUrl();
        if (!base) return;
        addServerBtn.disabled = true;
        try {
          const res = await fetch(new URL("/list", base).href);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const items = await res.json() as SourceItem[];
          const added = addFromServer(items, collection);
          catalog?.showLibrary();
          showToast(added > 0 ? `Added ${added} from server` : "Already up to date");
        } catch {
          showToast("Couldn't reach server");
        } finally {
          addServerBtn.disabled = false;
        }
      });
      rightGroup.appendChild(addServerBtn);
    }

    // Server status / configuration (right group)
    rightGroup.appendChild(serverSettings);

    return footer;
  }

  container.addEventListener("paste", (e) => {
    if (catalog && e.clipboardData?.files.length) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
      return;
    }
    const text = e.clipboardData?.getData("text/plain")?.trim();
    if (!text || !text.startsWith("[")) return;
    try {
      importMedia(text);
      showToast("Imported from paste");
      e.preventDefault();
    } catch {
      // Text started with "[" so it was clearly an import attempt — surface the
      // parse failure instead of swallowing it.
      showToast("Import failed: invalid JSON");
    }
  });

  // Drag & drop files or URLs
  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    container.style.outline = "2px solid #666";
  });
  container.addEventListener("dragleave", () => {
    container.style.outline = "";
  });
  container.addEventListener("drop", (e) => {
    e.preventDefault();
    container.style.outline = "";
    if (e.dataTransfer?.files.length) {
      addFiles(e.dataTransfer.files);
      return;
    }
    // Try text (URL or JSON)
    const text = e.dataTransfer?.getData("text/plain")?.trim();
    if (!text) return;
    if (text.startsWith("[")) {
      try { importMedia(text); showToast("Imported from drop"); return; }
      catch { showToast("Import failed: invalid JSON"); return; }
    }
    if (text.startsWith("http")) addUrl(text);
  });

  container.addEventListener("media-tab-activate", () => {
    catalog?.activate();
    render();
  });
  return render;
}

/** Stable key representing the *structural* fields of an entry — if unchanged,
 *  the row DOM node is reused as-is. Progress percentages (`uploadProgress`,
 *  `phasePercent`) and `phase` are deliberately excluded: a transcode/download
 *  tick shouldn't rebuild the row, because that tears out the name/url input the
 *  user may be typing in. Those are refreshed in place by `updateRowProgress`. */
export function entryRenderKey(entry: MediaEntry): string {
  return [
    entry.url,
    entry.type ?? "",
    entry.thumbnail ?? "",
    String(!!entry.downloading),
    String(!!entry.uploading),
    entry.error ?? "",
    String(!!entry.unavailable),
    entry.streamKind ?? "",
    entry.deviceId ?? "",
    String(entry.type === "stream" ? isStreamActive(entry.name) : false),
  ].join("\0");
}

/** Shared progress state for the edit row and the compact grid badge. */
function mediaProgress(entry: MediaEntry): { text: string; short: string; title: string; icon: string } | null {
  if (entry.uploading) {
    const pct = entry.uploadProgress != null ? Math.round(entry.uploadProgress * 100) : null;
    return pct != null && pct < 100
      ? { text: `${pct}%`, short: `${pct}%`, title: "Uploading…", icon: "upload-simple" }
      : { text: "", short: "", title: "Transcoding…", icon: "gear" };
  }
  if (entry.downloading) {
    // Two-phase YouTube progress: "downloading: 45%" then "transcoding: 13%".
    // Show an hourglass until the first /ready poll reports a phase.
    if (entry.phase && entry.phasePercent != null) {
      const label = entry.phase === "transcode" ? "transcoding" : "downloading";
      const pct = Math.round(entry.phasePercent * 100);
      const icon = entry.phase === "transcode" ? "gear" : "download-simple";
      return { text: `${label}: ${pct}%`, short: `${pct}%`, title: `${label} in progress`, icon };
    }
    return { text: "", short: "", title: "Waiting for download…", icon: "hourglass" };
  }
  return null;
}

function showProgress(el: HTMLElement, icon: string, text: string, title: string) {
  if (el.textContent !== text || !el.firstElementChild?.classList.contains(`ph-${icon}`)) {
    el.replaceChildren(phosphorIcon(icon), text);
  }
  el.title = title;
}

/** Refresh just the progress indicator's text/title in place, without rebuilding
 *  the row — so typing in the row's inputs isn't interrupted by progress ticks. */
function updateRowProgress(row: HTMLElement, entry: MediaEntry) {
  const indicator = row.querySelector<HTMLElement>(".vid-indicator");
  const p = mediaProgress(entry);
  if (!indicator || !p) return;
  showProgress(indicator, p.icon, p.text, p.title);
}

/** Show/refresh (or remove) the compact progress badge in a grid cell's
 *  bottom-right corner. Managed here rather than in makeThumbCell so the cell
 *  isn't rebuilt each progress tick (which would reload its <img>). */
function updateCellProgress(cell: HTMLElement, entry: MediaEntry) {
  const p = mediaProgress(entry);
  let badge = cell.querySelector<HTMLElement>(".thumb-progress");
  if (!p) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "thumb-progress";
    // Into the flex bottom bar so the label shrinks to make room (no overlap).
    (cell.querySelector(".thumb-bar") ?? cell).appendChild(badge);
  }
  showProgress(badge, p.icon, p.short, p.title);
}

function reconcileList(list: HTMLElement, entries: MediaEntry[]) {
  // Index existing rows by entry name.
  const byName = new Map<string, HTMLElement>();
  for (const child of Array.from(list.children) as HTMLElement[]) {
    const name = child.dataset.entryName;
    if (name) byName.set(name, child);
  }

  const seen = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    seen.add(entry.name);
    const key = entryRenderKey(entry);
    let row = byName.get(entry.name);

    if (row) {
      // Replace row only when something visual changed.
      if (row.dataset.entryKey !== key) {
        const newRow = makeRow(entry);
        newRow.dataset.entryName = entry.name;
        newRow.dataset.entryKey = key;
        list.replaceChild(newRow, row);
        row = newRow;
        byName.set(entry.name, row);
      }
    } else {
      row = makeRow(entry);
      row.dataset.entryName = entry.name;
      row.dataset.entryKey = key;
      byName.set(entry.name, row);
    }

    // Refresh progress text in place (row was reused, key excludes percentages).
    updateRowProgress(row, entry);

    // Ensure the row sits at position i without moving it unnecessarily.
    const atI = list.children[i] as HTMLElement | undefined;
    if (atI !== row) {
      list.insertBefore(row, atI ?? null);
    }
  }

  // Remove rows for entries that no longer exist.
  for (const [name, el] of byName) {
    if (!seen.has(name)) el.remove();
  }

  // Empty-state placeholder.
  const emptyEl = list.querySelector<HTMLElement>("[data-empty]");
  if (entries.length === 0 && !emptyEl) {
    const empty = document.createElement("p");
    empty.dataset.empty = "1";
    empty.textContent = "No media added yet";
    empty.className = "vid-empty";
    list.prepend(empty);
  } else if (entries.length > 0 && emptyEl) {
    emptyEl.remove();
  }
}

/** Reconcile the "view"-mode thumbnail grid in place — mirror of reconcileList,
 *  keyed by entry id, reusing cells whose cellKey is unchanged (no img reload). */
export function reconcileGrid(grid: HTMLElement, entries: MediaEntry[]) {
  const byId = new Map<string, HTMLElement>();
  for (const child of Array.from(grid.children) as HTMLElement[]) {
    if (child.dataset.entryId) byId.set(child.dataset.entryId, child);
  }

  const seen = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    seen.add(entry.id);
    const key = cellKey(entry);
    let cell = byId.get(entry.id);

    if (!cell || cell.dataset.cellKey !== key) {
      const newCell = makeThumbCell(entry, insertName);
      newCell.dataset.entryId = entry.id;
      newCell.dataset.cellKey = key;
      // Drag the cell to reorder (shared registry order → the list reorders too).
      attachReorder(newCell, newCell, entry, "x");
      if (cell) grid.replaceChild(newCell, cell);
      cell = newCell;
      byId.set(entry.id, cell);
    }

    // Progress badge (bottom-right) refreshed in place — cellKey excludes
    // progress, so the cell (and its <img>) isn't rebuilt each tick.
    updateCellProgress(cell, entry);

    const atI = grid.children[i] as HTMLElement | undefined;
    if (atI !== cell) grid.insertBefore(cell, atI ?? null);
  }

  for (const [id, el] of byId) {
    if (!seen.has(id)) el.remove();
  }

  // Empty-state placeholder (spans the whole grid width).
  const emptyEl = grid.querySelector<HTMLElement>("[data-empty]");
  if (entries.length === 0 && !emptyEl) {
    const empty = document.createElement("p");
    empty.dataset.empty = "1";
    empty.textContent = "No media added yet";
    empty.className = "vid-empty";
    empty.style.gridColumn = "1 / -1";
    grid.appendChild(empty);
  } else if (entries.length > 0 && emptyEl) {
    emptyEl.remove();
  }
}

// --- Drag to reorder (Pointer Events → mouse, touch, and pen alike), with a
// live preview: the dragged element is moved among its siblings as you drag, so
// you see where it lands. The registry isn't touched until release, when
// moveMediaBefore commits the previewed order (so both panes + the URL update);
// a cancelled drag is restored by the final render().
//
// Touch: a short press-and-hold lifts the item (so ordinary finger-scrolling of
// the list still works — moving before the hold aborts to a scroll), and page
// scroll is suppressed only while a drag is actually active. ---
const DRAG_THRESHOLD = 6;   // px of movement to start a mouse drag / abort a touch hold
const TOUCH_HOLD_MS = 220;  // press-and-hold before a touch drag lifts

type DragState = {
  drop: NodeDrop; name: string; el: HTMLElement; handle: HTMLElement; pane: HTMLElement; axis: "x" | "y";
  pointerId: number; startX: number; startY: number;
  isTouch: boolean; active: boolean; holdTimer?: ReturnType<typeof setTimeout>;
  preview?: ReturnType<typeof liftMediaThumbnail>;
};
let drag: DragState | null = null;

function preventTouchScroll(e: TouchEvent) { if (drag?.active) e.preventDefault(); }

function beginActive() {
  if (!drag || drag.active) return;
  clearTimeout(drag.holdTimer);
  drag.active = true;
  drag.preview = liftMediaThumbnail(drag.handle, drag.startX, drag.startY);
  drag.el.classList.add("drag-placeholder");
  document.addEventListener("touchmove", preventTouchScroll, { passive: false });
}

/** Slot the dragged element before/after whichever item is under the pointer. */
function previewAt(x: number, y: number) {
  if (!drag) return;
  const under = document.elementFromPoint(x, y) as HTMLElement | null;
  const target = under?.closest<HTMLElement>(drag.axis === "x" ? ".thumb-cell" : ".vid-row");
  // Only react when over an actual item. Over a gap/empty area elementFromPoint
  // returns the pane (target null) → do nothing, rather than flinging it to the
  // end. The end is still reachable by hovering the last item (it's "after" the
  // dragged one, so the direction rule appends).
  if (!target || target === drag.el || target.parentElement !== drag.pane) return;
  // Just hovering an item moves the dragged one to that slot; the side is set by
  // direction (is the target currently after or before the dragged element), not
  // the target's midpoint — so there's no dead half. After the move the dragged
  // element sits under the cursor, so the early-return above stops it oscillating.
  const after = !!(drag.el.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
  const ref = after ? target.nextElementSibling : target;
  if (ref !== drag.el && drag.el.nextElementSibling !== ref) drag.pane.insertBefore(drag.el, ref);
}

function onPointerMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (moved <= DRAG_THRESHOLD) return;
    if (drag.isTouch) { finishDrag(false); return; } // moved before the hold → let it scroll
    beginActive();
  }
  drag.preview?.move(e.clientX, e.clientY);
  if (!sidebarDrop(drag.drop, e.clientX, e.clientY, false, { hasThumbnail: true })) {
    previewAt(e.clientX, e.clientY);
  }
}

function onPointerUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const inGraph = drag.active && sidebarDrop(drag.drop, e.clientX, e.clientY, true);
  const under = document.elementFromPoint(e.clientX, e.clientY);
  finishDrag(!inGraph && Boolean(under && drag.pane.contains(under)));
}
function onPointerCancel(e: PointerEvent) {
  if (drag && e.pointerId === drag.pointerId) finishDrag(false);
}

function onDragKeyDown(e: KeyboardEvent) { if (e.key === "Escape") finishDrag(false); }
function onDragBlur() { finishDrag(false); }

function finishDrag(commit: boolean) {
  if (!drag) return;
  const { el, name, active, preview } = drag;
  clearTimeout(drag.holdTimer);
  document.removeEventListener("pointermove", onPointerMove);
  document.removeEventListener("pointerup", onPointerUp);
  document.removeEventListener("pointercancel", onPointerCancel);
  document.removeEventListener("keydown", onDragKeyDown);
  document.removeEventListener("touchmove", preventTouchScroll);
  window.removeEventListener("blur", onDragBlur);
  sidebarDrop(null);
  drag = null;
  if (!active) return; // never lifted → it was a tap/scroll; leave the click alone
  preview?.remove();
  el.classList.remove("drag-placeholder");
  if (commit) {
    const next = el.nextElementSibling as HTMLElement | null;
    const beforeName = next ? (next.dataset.entryName ?? next.dataset.flipKey ?? null) : null;
    moveMediaBefore(name, beforeName);
  }
  // Swallow the click that a mouse-up/tap fires right after a real drag, so the
  // drop doesn't also insert the clip's name.
  ignoreDropClick();
  render(); // normalise DOM to the registry (commit applied it; a cancel restores it)
}

/** Wire `handle` to start a reorder of `item` (the row or cell) on press. */
function attachReorder(handle: HTMLElement, item: HTMLElement, entry: MediaEntry, axis: "x" | "y") {
  handle.addEventListener("pointerdown", (e) => {
    if (drag || e.button !== 0 || !e.isPrimary) return;
    const pane = item.parentElement;
    if (!pane) return;
    drag = {
      drop: { kind: isTexture(entry) ? "texture" : "media", data: { media: entry.id } },
      name: entry.name, el: item, handle, pane, axis,
      pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      isTouch: e.pointerType === "touch", active: false,
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onDragKeyDown);
    window.addEventListener("blur", onDragBlur);
    if (drag.isTouch) drag.holdTimer = setTimeout(beginActive, TOUCH_HOLD_MS);
  });
}

function makeRow(entry: MediaEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "vid-row";

  const isStream = entry.type === "stream";

  // Thumbnail / stream status dot. Clicking it inserts the name at the cursor
  // (same as the grid); flip-key pairs it with the grid cell for the transition.
  const thumb = document.createElement("div");
  thumb.className = "vid-thumb";
  thumb.dataset.flipKey = entry.name;
  thumb.title = `Insert "${entry.name}"`;
  thumb.addEventListener("click", () => insertName(entry.name));
  if (isStream) {
    const active = isStreamActive(entry.name);
    const status = active ? "Active" : "Disconnected";
    const dot = phosphorIcon(active ? "record" : "circle", "vid-status-dot");
    dot.style.color = active ? "#4c4" : "#666";
    thumb.title = status;
    thumb.appendChild(dot);
  } else if (entry.unavailable) {
    // Source failed to load/decode — show a warning glyph instead of a thumbnail.
    const warn = document.createElement("span");
    warn.className = "vid-thumb-warn";
    warn.append(phosphorIcon("warning"));
    warn.style.color = "#e8a13a"; // dynamic state — kept inline like the stream dot
    warn.style.fontSize = "18px";
    warn.title = "Won't play — couldn't decode this source. It may be an unsupported format (e.g. 10-bit HEVC from an iPhone), corrupt, or offline.";
    thumb.appendChild(warn);
  } else if (entry.thumbnail) {
    const img = document.createElement("img");
    img.src = entry.thumbnail; // styled via `.vid-thumb img`
    img.draggable = false; // so dragging the thumb reorders the row, not the image
    thumb.appendChild(img);
  }
  row.appendChild(thumb);

  // Name input
  const nameInput = document.createElement("input");
  nameInput.value = entry.name;
  nameInput.className = "vid-name";
  nameInput.addEventListener("blur", () => {
    const newName = nameInput.value.trim();
    if (newName && newName !== entry.name) {
      const finalName = renameMedia(entry.name, newName);
      if (finalName) nameInput.value = finalName;
    }
  });
  row.appendChild(nameInput);

  if (isStream) {
    // Stream type label + reconnect/stop
    const label = document.createElement("span");
    label.textContent = entry.streamKind ?? "stream";
    label.className = "vid-stream-label";
    row.appendChild(label);

    const active = isStreamActive(entry.name);
    if (active) {
      const stopBtn = document.createElement("button");
      stopBtn.textContent = "Stop";
      stopBtn.className = "vid-btn-stop";
      stopBtn.addEventListener("click", () => { stopStream(entry.name); render(); });
      row.appendChild(stopBtn);
    } else {
      const reconnBtn = document.createElement("button");
      reconnBtn.textContent = "Reconnect";
      reconnBtn.className = "vid-btn-reconnect";
      reconnBtn.addEventListener("click", async () => {
        try {
          if (entry.streamKind === "webcam") {
            await startWebcam(entry.name, entry.deviceId);
          } else {
            await startScreenCapture(entry.name);
          }
          render();
        } catch (e: any) {
          showToast(e.message ?? "Reconnect failed");
        }
      });
      row.appendChild(reconnBtn);
    }
  } else {
    // URL input
    const urlInput = document.createElement("input");
    urlInput.value = entry.url;
    urlInput.className = "vid-url";
    urlInput.addEventListener("blur", () => {
      const newUrl = urlInput.value.trim();
      if (newUrl && newUrl !== entry.url) {
        updateUrl(entry.name, newUrl);
        if (isYouTubeUrl(newUrl)) downloadYouTube(entry.name);
      }
    });
    row.appendChild(urlInput);

    // Status indicators. Progress comes from mediaProgress() so the initial
    // build and the in-place updateRowProgress() refresh never diverge.
    const progress = mediaProgress(entry);
    if (progress) {
      const indicator = document.createElement("span");
      indicator.className = entry.downloading ? "vid-indicator dl" : "vid-indicator";
      showProgress(indicator, progress.icon, progress.text, progress.title);
      row.appendChild(indicator);
    } else if (entry.error) {
      const retryBtn = document.createElement("button");
      retryBtn.append(phosphorIcon("arrow-clockwise"));
      retryBtn.setAttribute("aria-label", `Retry ${entry.name}`);
      retryBtn.title = entry.error;
      retryBtn.className = "vid-btn-retry";
      retryBtn.addEventListener("click", () => {
        updateEntry(entry.name, { error: undefined });
        if (entry.pendingFile) {
          uploadToServer(entry.name, entry.pendingFile).catch(() => {/* error stored in entry */});
        } else {
          downloadYouTube(entry.name);
        }
      });
      row.appendChild(retryBtn);
    }
  }

  // Delete button
  const delBtn = document.createElement("button");
  delBtn.append(phosphorIcon("x"));
  delBtn.setAttribute("aria-label", `Remove ${entry.name}`);
  delBtn.className = "vid-btn-delete";
  delBtn.addEventListener("click", () => {
    if (isStream) removeStream(entry.name);
    else removeMedia(entry.name);
  });
  row.appendChild(delBtn);

  // Drag by the thumbnail to reorder the row up/down (shared registry order → the
  // grid reorders too). On touch, press-and-hold the thumbnail to lift it.
  attachReorder(thumb, row, entry, "y");

  return row;
}

function makeFooterBtn(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.className = "pd-btn-flat";
  btn.addEventListener("click", onClick);
  return btn;
}

function showToast(msg: string) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.className = "pd-toast";
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; }, 1500);
  setTimeout(() => el.remove(), 1800);
}
