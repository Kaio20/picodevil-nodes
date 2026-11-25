import * as Blockly from "blockly";
import { blockCatalog, blockPalette, type BlockChoice } from "./block-definitions";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text: string) {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

const categoryOrder: BlockChoice["category"][] = ["Sources", "Playback", "Layout", "Image", "Expressions", "Signals", "Text", "Output"];

function match(choice: BlockChoice, terms: string[]): number {
  const name = choice.name.toLowerCase();
  const aliases = (choice.aliases ?? []).map(alias => alias.toLowerCase());
  let score = 0;
  for (const term of terms) {
    if (name === term || aliases.includes(term)) score += 10;
    else if (name.split(/\W+/).some(part => part.startsWith(term)) || aliases.some(alias => alias.startsWith(term))) score += 6;
    else if (name.includes(term) || aliases.some(alias => alias.includes(term))) score += 3;
    else if (choice.category.toLowerCase().includes(term)) score += 1;
    else return 0;
  }
  return score;
}

/** Two-column catalog adapted from the Node Fork's Add Node menu. */
export function setupBlockMenu(workspace: Blockly.WorkspaceSvg, surface: HTMLElement, trigger: HTMLButtonElement) {
  const menu = element("div", "bd-add-menu");
  menu.id = "bd-add-menu";
  menu.popover = "manual";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Add Node");
  trigger.setAttribute("aria-controls", menu.id);
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-haspopup", "dialog");
  const left = element("div", "bd-add-categories");
  const search = element("input", "bd-add-search");
  search.type = "search";
  search.placeholder = "Search nodes…";
  search.setAttribute("aria-label", "Search nodes");
  const categories = element("div", "bd-add-category-list");
  categories.setAttribute("role", "group");
  categories.setAttribute("aria-label", "Node categories");
  left.append(search, categories);
  const right = element("section", "bd-add-results");
  right.id = "bd-add-results";
  const heading = element("h2", "bd-add-heading");
  heading.id = "bd-add-heading";
  right.setAttribute("aria-labelledby", heading.id);
  const results = element("div", "bd-add-list");
  right.append(heading, results);
  menu.append(left, right);
  surface.append(menu);

  let position = new Blockly.utils.Coordinate(0, 0);
  let active = categoryOrder[0];
  let restoreFocus: HTMLElement | null = null;
  let hoverTimer: number | undefined;
  const tabs = new Map<BlockChoice["category"], HTMLButtonElement>();
  const isOpen = () => menu.matches(":popover-open");

  function cancelHover() {
    window.clearTimeout(hoverTimer);
    hoverTimer = undefined;
  }

  function close(focus = false) {
    if (!isOpen()) return;
    cancelHover();
    menu.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    if (focus && restoreFocus?.isConnected) restoreFocus.focus();
  }

  function choose(choice: BlockChoice) {
    close(true);
    const created = Blockly.serialization.blocks.append({ ...choice.state, x: position.x, y: position.y }, workspace, { recordUndo: true });
    if (created instanceof Blockly.BlockSvg) created.select();
  }

  function render() {
    const query = search.value.toLowerCase().match(/[\w-]+/g) ?? [];
    heading.textContent = query.length ? "Search results" : active;
    heading.style.setProperty("--bd-category", query.length ? "#adb2bd" : blockPalette[active]);
    for (const [name, tab] of tabs) tab.setAttribute("aria-expanded", String(!query.length && active === name));
    const choices = query.length
      ? blockCatalog.map(choice => ({ choice, score: match(choice, query) })).filter(item => item.score).sort((a, b) => b.score - a.score).map(item => item.choice)
      : blockCatalog.filter(choice => choice.category === active);
    results.replaceChildren();
    for (const choice of choices) {
      const row = button("bd-add-item", choice.name);
      row.style.setProperty("--bd-category", blockPalette[choice.category]);
      if (query.length) row.append(element("span", "bd-add-item-category", choice.category));
      row.addEventListener("click", () => choose(choice));
      results.append(row);
    }
    if (!choices.length) results.append(element("p", "bd-add-empty", "No matching nodes"));
  }

  for (const category of categoryOrder) {
    const tab = button("bd-add-category", category);
    tab.style.setProperty("--bd-category", blockPalette[category]);
    tab.setAttribute("aria-controls", right.id);
    tab.append(element("span", "bd-add-arrow", "›"));
    tab.lastElementChild?.setAttribute("aria-hidden", "true");
    tab.addEventListener("pointerenter", event => {
      if (event.pointerType === "touch" || search.value.trim()) return;
      cancelHover();
      hoverTimer = window.setTimeout(() => { active = category; render(); }, 95);
    });
    tab.addEventListener("pointerleave", cancelHover);
    tab.addEventListener("click", event => {
      cancelHover();
      active = category;
      search.value = "";
      render();
      if (event.detail === 0) results.querySelector("button")?.focus();
    });
    tabs.set(category, tab);
    categories.append(tab);
  }

  search.addEventListener("input", render);
  menu.addEventListener("keydown", event => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (target === search && event.key === "Enter") {
      event.preventDefault();
      results.querySelector("button")?.click();
    } else if (categories.contains(target) && event.key === "ArrowRight") {
      event.preventDefault();
      target.click();
    } else if (results.contains(target) && event.key === "ArrowLeft") {
      event.preventDefault();
      if (search.value.trim()) search.focus();
      else tabs.get(active)?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const items = Array.from((categories.contains(target) || (target === search && !search.value.trim()) ? categories : results).querySelectorAll("button"));
      const index = items.indexOf(target as HTMLButtonElement);
      if (!items.length) return;
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      items[(index + offset + (index < 0 && offset < 0 ? 1 : 0) + items.length) % items.length]?.focus();
    }
  });

  function open(point: Blockly.utils.Coordinate, anchor = point) {
    position = Blockly.utils.svgMath.screenToWsCoordinates(workspace, point);
    if (!isOpen()) restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
    search.value = "";
    active = categoryOrder[0];
    render();
    const workspaceBounds = surface.getBoundingClientRect();
    menu.style.setProperty("--bd-menu-width", `${Math.max(0, workspaceBounds.width - 12)}px`);
    menu.style.setProperty("--bd-menu-height", `${Math.max(0, workspaceBounds.height - 12)}px`);
    if (!isOpen()) menu.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(workspaceBounds.left + 6, Math.min(anchor.x, workspaceBounds.right - bounds.width - 6))}px`;
    menu.style.top = `${Math.max(workspaceBounds.top + 6, Math.min(anchor.y, workspaceBounds.bottom - bounds.height - 6))}px`;
    search.focus();
  }

  trigger.addEventListener("click", () => {
    if (isOpen()) { close(); return; }
    const workspaceBounds = surface.getBoundingClientRect();
    const anchor = trigger.getBoundingClientRect();
    open(new Blockly.utils.Coordinate(workspaceBounds.left + workspaceBounds.width * 0.62, workspaceBounds.top + 52),
      new Blockly.utils.Coordinate(anchor.left, anchor.bottom + 5));
  });

  const isBackground = (target: EventTarget | null) => target instanceof Element && target.classList.contains("blocklyMainBackground");
  // Blockly opens its default workspace menu on pointerdown. Let contextmenu
  // open our catalog instead, leaving block-specific actions available.
  surface.addEventListener("pointerdown", event => {
    if (event.button === 2 && isBackground(event.target)) event.stopPropagation();
  }, true);
  surface.addEventListener("contextmenu", event => {
    if (!isBackground(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    open(new Blockly.utils.Coordinate(event.clientX, event.clientY));
  }, true);
  document.addEventListener("pointerdown", event => {
    if (!event.composedPath().includes(menu) && !event.composedPath().includes(trigger)) close();
  }, true);
  Blockly.ContextMenuRegistry.registry.register({
    id: "picodevilAddNode",
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    displayText: "Add Node",
    weight: 1,
    preconditionFn: scope => scope.block?.workspace === workspace ? "enabled" : "hidden",
    callback: (_scope, _event, _selection, location) => open(location),
  });
  return close;
}
