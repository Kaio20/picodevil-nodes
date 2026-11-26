import type { ChoiceSuggestions } from "./editor-catalog";

let nextMenuId = 0;

export function choiceField(
  input: HTMLInputElement,
  label: string,
  choices: ChoiceSuggestions,
  commit: (value: string) => void,
) {
  const field = document.createElement("span");
  field.className = "pd-choice-tools";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.tabIndex = -1;
  toggle.className = "pd-choice-toggle";
  toggle.textContent = "▾";
  toggle.setAttribute("aria-label", `Show ${label} options`);

  const menu = document.createElement("div");
  menu.id = `pd-choice-${++nextMenuId}`;
  menu.className = "pd-choice-menu";
  menu.popover = "manual";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", `${label} options`);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", menu.id);
  input.autocomplete = "off";
  field.append(input, toggle, menu);

  let options: HTMLElement[] = [];
  let active = -1;
  const isOpen = () => menu.matches(":popover-open");

  function activate(index: number) {
    options[active]?.removeAttribute("data-active");
    active = index;
    const option = options[index];
    if (option) {
      option.setAttribute("data-active", "");
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function close() {
    if (isOpen()) menu.hidePopover();
    input.setAttribute("aria-expanded", "false");
    activate(-1);
  }

  function select(value: string) {
    input.value = value;
    commit(value);
    close();
  }

  function show(query = "") {
    const term = query.trim().toLowerCase();
    menu.replaceChildren();
    options = [];
    activate(-1);

    for (const [label, items] of [["Common", choices.common], ["More", choices.other ?? []]] as const) {
      const matches = items.filter(choice => choice.toLowerCase().includes(term));
      if (!matches.length) continue;
      const group = document.createElement("div");
      group.className = "pd-choice-group";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", label);
      if (choices.other?.length && !term) {
        const heading = document.createElement("div");
        heading.className = "pd-choice-heading";
        heading.textContent = label;
        heading.setAttribute("aria-hidden", "true");
        group.append(heading);
      }
      for (const value of matches) {
        const option = document.createElement("div");
        option.id = `${menu.id}-${options.length}`;
        option.className = "pd-choice-option";
        option.textContent = value;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(input.value === value));
        option.addEventListener("click", () => select(value));
        group.append(option);
        options.push(option);
      }
      menu.append(group);
    }

    if (!options.length) { close(); return; }
    if (!isOpen()) menu.showPopover();
    input.setAttribute("aria-expanded", "true");
    const gap = 6;
    const bounds = field.getBoundingClientRect();
    const width = Math.min(Math.max(bounds.width, 160), innerWidth - gap * 2);
    const below = innerHeight - bounds.bottom - gap * 2;
    const above = bounds.top - gap * 2;
    const opensAbove = below < Math.min(menu.scrollHeight, 240) && above > below;
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.min(240, opensAbove ? above : below)}px`;
    menu.style.left = `${Math.max(gap, Math.min(bounds.left, innerWidth - width - gap))}px`;
    menu.style.top = `${opensAbove ? bounds.top - gap - menu.offsetHeight : bounds.bottom + gap}px`;
    menu.scrollTop = 0;
  }

  input.addEventListener("focus", () => show());
  input.addEventListener("click", () => { if (!isOpen()) show(); });
  input.addEventListener("input", () => show(input.value));
  field.addEventListener("focusout", event => {
    if (!(event.relatedTarget instanceof Node) || !field.contains(event.relatedTarget)) close();
  });
  toggle.addEventListener("mousedown", event => event.preventDefault());
  menu.addEventListener("mousedown", event => event.preventDefault());
  toggle.addEventListener("click", () => {
    if (isOpen()) close();
    else { input.focus(); if (!isOpen()) show(); }
  });
  input.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen()) show();
      const count = options.length;
      const next = event.key === "ArrowDown" ? (active + 1) % count : active <= 0 ? count - 1 : active - 1;
      if (count) activate(next);
    } else if (isOpen() && (event.key === "Escape" || event.key === "Enter")) {
      event.preventDefault();
      if (event.key === "Enter" && active >= 0) select(options[active].textContent!);
      else close();
    }
  });
  return field;
}
