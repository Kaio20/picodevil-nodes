import { setupReference, type RefEntry } from "./reference";
import { setupMediaLoader } from "./media-loader";
import { setupPerfPanel } from "./perf-panel";
import { setupAudioTab } from "./audio-sidebar";
import { setupExamples, type Example } from "./examples";
import aboutHtml from "./about.html?raw";

const STORAGE_KEY = "picodevil-sidebar";

function loadState(): { open?: boolean; tab?: string; width?: number } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch { return {}; }
}

function saveState(updates: Partial<{ open: boolean; tab: string; width: number }>) {
  const state = { ...loadState(), ...updates };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * Whether the sidebar should start open.
 *
 * Open by default; only an explicit toggle-close (which stores `open: false`)
 * keeps it closed on reload. We key off the stored `open` field, NOT off whether
 * *anything* is stored — otherwise persisting some other field (e.g. switching a
 * tab writes `{tab}`, resizing writes `{width}`) would demote a never-closed
 * sidebar to closed on the next load.
 *
 * The default active tab (About) lives in index.html, overridden by a stored
 * `tab` in setupSidebar.
 */
export function resolveSidebarOpen(raw: string | null): boolean {
  if (raw === null) return true;
  try { return JSON.parse(raw).open ?? true; } catch { return true; }
}

export function setupSidebar(isFreshSession: boolean, defaultTab: string | undefined, onExample: (example: Example) => void) {
  const toggle = document.getElementById("sidebar-toggle")!;
  const panel = document.getElementById("sidebar-panel")!;
  const handle = panel.querySelector<HTMLElement>(".resize-handle")!;
  const saved = loadState();

  // Apply open state. index.html renders the panel closed (so nothing half-open
  // flashes before JS runs); open it here for a first visit / untouched reload.
  // Suppress the transition for this initial set so it snaps to its resting state
  // instead of sliding on load — re-enabled below so later user toggles animate.
  const open = resolveSidebarOpen(localStorage.getItem(STORAGE_KEY));
  panel.style.transition = "none";
  panel.classList.toggle("open", open);
  toggle.classList.toggle("open", open);
  toggle.textContent = open ? "›" : "‹";
  void panel.offsetWidth; // force reflow so "none" applies before restoring
  panel.style.transition = "";

  // Restore width
  if (saved.width) {
    panel.style.width = saved.width + "px";
  }

  const setOpen = (open: boolean) => {
    panel.classList.toggle("open", open);
    toggle.classList.toggle("open", open);
    toggle.textContent = open ? "›" : "‹";
    saveState({ open });
  };
  toggle.addEventListener("click", () => setOpen(!panel.classList.contains("open")));

  // Drag left edge to resize
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel.offsetWidth;

    const onMove = (e: MouseEvent) => {
      const w = Math.max(200, startWidth + (startX - e.clientX));
      panel.style.width = w + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      saveState({ width: panel.offsetWidth });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Populate tabs
  const refTab = document.getElementById("tab-reference");
  const showReference = refTab && setupReference(refTab);
  const videosTab = document.getElementById("tab-videos");
  const texturesTab = document.getElementById("tab-textures");
  if (videosTab) setupMediaLoader(videosTab, isFreshSession, texturesTab);
  const perfTab = document.getElementById("tab-perf");
  if (perfTab) setupPerfPanel(perfTab);
  const audioTab = document.getElementById("tab-audio");
  if (audioTab) setupAudioTab(audioTab);
  const aboutTab = document.getElementById("tab-about");
  if (aboutTab) aboutTab.innerHTML = aboutHtml;
  const examplesTab = document.getElementById("tab-examples");
  if (examplesTab) setupExamples(examplesTab, onExample);

  // Tabs
  const tabs = panel.querySelectorAll<HTMLButtonElement>(".tabs button");
  const contents = panel.querySelectorAll<HTMLElement>(".tab-content");
  const setTab = (name: string) => {
    tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
    contents.forEach(content => content.classList.toggle("active", content.id === `tab-${name}`));
    if (name === "videos" || name === "textures") {
      document.getElementById(`tab-${name}`)?.dispatchEvent(new Event("media-tab-activate"));
    }
  };

  // Restore active tab, overriding the About default (index.html) when stored
  const startingTab = saved.tab ?? defaultTab;
  if (startingTab) setTab(startingTab);

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (!tab.dataset.tab) return;
      setTab(tab.dataset.tab);
      saveState({ tab: tab.dataset.tab });
    });
  });

  return {
    openReference(entry: RefEntry) {
      if (!showReference) return;
      if (!panel.classList.contains("open")) setOpen(true);
      setTab("reference");
      saveState({ tab: "reference" });
      showReference(entry);
    },
  };
}
