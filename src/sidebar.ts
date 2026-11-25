import { setupReference } from "./reference";
import { setupMediaLoader } from "./media-loader";
import { setupPerfPanel } from "./perf-panel";
import { setupAudioTab } from "./audio-sidebar";
import { setupExamples } from "./examples";
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
export function resolveSidebarOpen(raw: string | null, defaultOpen = true): boolean {
  if (raw === null) return defaultOpen;
  try { return JSON.parse(raw).open ?? defaultOpen; } catch { return defaultOpen; }
}

export function setupSidebar(isFreshSession = false, defaultOpen = true, defaultTab?: string) {
  const toggle = document.getElementById("sidebar-toggle")!;
  const panel = document.getElementById("sidebar-panel")!;
  const handle = panel.querySelector<HTMLElement>(".resize-handle")!;
  const saved = loadState();

  // Apply open state. index.html renders the panel closed (so nothing half-open
  // flashes before JS runs); open it here for a first visit / untouched reload.
  // Suppress the transition for this initial set so it snaps to its resting state
  // instead of sliding on load — re-enabled below so later user toggles animate.
  const open = resolveSidebarOpen(localStorage.getItem(STORAGE_KEY), defaultOpen);
  panel.style.transition = "none";
  panel.classList.toggle("open", open);
  toggle.classList.toggle("open", open);
  toggle.textContent = open ? "›" : "‹";
  void panel.offsetWidth; // force reflow so "none" applies before restoring
  panel.style.transition = "";

  function setWidth(width: number) {
    panel.style.width = `${width}px`;
    document.body.style.setProperty("--bd-rail-width-preferred", `${width}px`);
  }
  if (saved.width) setWidth(saved.width);

  const labelToggle = () => toggle.setAttribute("aria-expanded", String(panel.classList.contains("open")));
  labelToggle();

  toggle.addEventListener("click", () => {
    const open = panel.classList.toggle("open");
    toggle.classList.toggle("open", open);
    toggle.textContent = open ? "›" : "‹";
    labelToggle();
    saveState({ open });
  });

  // Drag left edge to resize
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel.offsetWidth;

    const onMove = (e: MouseEvent) => {
      const w = Math.max(200, startWidth + (startX - e.clientX));
      setWidth(w);
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
  if (refTab) setupReference(refTab);
  const videosTab = document.getElementById("tab-videos");
  if (videosTab) setupMediaLoader(videosTab, isFreshSession);
  const perfTab = document.getElementById("tab-perf");
  if (perfTab) setupPerfPanel(perfTab);
  const audioTab = document.getElementById("tab-audio");
  if (audioTab) setupAudioTab(audioTab);
  const aboutTab = document.getElementById("tab-about");
  if (aboutTab) aboutTab.innerHTML = aboutHtml;
  const examplesTab = document.getElementById("tab-examples");
  if (examplesTab) setupExamples(examplesTab);

  // Tabs
  const tabs = panel.querySelectorAll<HTMLButtonElement>(".tabs button");

  function selectTab(name: string) {
    tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
    panel.querySelectorAll<HTMLElement>(".tab-content").forEach(el => el.classList.toggle("active", el.id === `tab-${name}`));
  }

  const initialTab = defaultTab ?? saved.tab;
  if (initialTab && Array.from(tabs).some(tab => tab.dataset.tab === initialTab)) selectTab(initialTab);

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      if (!name) return;
      selectTab(name);
      saveState({ tab: name });
    });
  });
  return { selectTab };
}
