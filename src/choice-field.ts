import { controlGlyph } from "./control-glyph";

export type SelectChoice<T extends string = string> = [id: T, label: string, description?: string, group?: string];

let nextListId = 0;

export function choiceField<T extends string>(
  choices: readonly SelectChoice<T>[], value: string, label: string,
  onChange: (value: T) => void, onPreview?: (value?: T) => void,
) {
  const field = document.createElement("div");
  field.className = "nd-choice-field";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "nd-field nd-choice-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-label", label);
  trigger.setAttribute("aria-expanded", "false");
  const selection = document.createTextNode("");
  trigger.append(selection, controlGlyph("⌄"));

  const list = document.createElement("div");
  list.id = `nd-choices-${++nextListId}`;
  list.className = "nd-choice-list";
  list.popover = "auto";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", label);
  trigger.setAttribute("aria-controls", list.id);
  trigger.popoverTargetElement = list;
  field.append(trigger, list);

  let selected = -1;
  let active = -1;
  let options: HTMLElement[] = [];
  let search = "";
  let lastKey = 0;
  const isOpen = () => list.matches(":popover-open");

  function highlight(index: number, scroll = false) {
    if (index === active) return;
    options[active]?.classList.remove("is-active");
    active = index;
    const option = options[index];
    if (option) {
      option.classList.add("is-active");
      trigger.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView({ block: "nearest" });
    } else {
      trigger.removeAttribute("aria-activedescendant");
    }
    onPreview?.(index === selected ? undefined : choices[index]?.[0]);
  }

  function setValue(next: string) {
    options[selected]?.setAttribute("aria-selected", "false");
    value = next;
    selected = choices.findIndex(([id]) => id === value);
    options[selected]?.setAttribute("aria-selected", "true");
    const choice = choices[selected];
    selection.data = choice?.[1] ?? "";
    trigger.dataset.value = value;
    trigger.dataset.tooltip = choice && (value || choice[2]) ? [choice[1], choice[2]].filter(Boolean).join("\n") : "";
  }

  function accept(index: number) {
    const choice = choices[index];
    if (!choice) return;
    list.hidePopover();
    trigger.focus();
    if (choice[0] === value) return;
    setValue(choice[0]);
    onChange(choice[0]);
  }

  function setChoices(next: readonly SelectChoice<T>[], current: string) {
    if (isOpen()) list.hidePopover();
    choices = next;
    let parent: HTMLElement = list;
    let group: string | undefined;
    list.replaceChildren();
    options = choices.map(([, name, , groupName], index) => {
      if (group !== groupName) {
        group = groupName;
        parent = list;
        if (group) {
          parent = document.createElement("div");
          parent.setAttribute("role", "group");
          parent.setAttribute("aria-label", group);
          const heading = document.createElement("div");
          heading.className = "nd-choice-group";
          heading.textContent = group;
          heading.setAttribute("aria-hidden", "true");
          parent.append(heading);
          list.append(parent);
        }
      }
      const option = document.createElement("div");
      option.id = `${list.id}-${index}`;
      option.className = "nd-choice-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.append(name, controlGlyph("✓"));
      option.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") highlight(index); });
      option.addEventListener("pointerleave", event => { if (event.pointerType !== "touch") highlight(-1); });
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => accept(index));
      parent.append(option);
      return option;
    });
    selected = -1;
    setValue(current);
  }

  list.addEventListener("beforetoggle", event => {
    const open = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) {
      highlight(-1);
      search = "";
      return;
    }
    // Prefer opening beside the trigger when the viewport has room.
    const gap = 6;
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(bounds.width, 176), innerWidth - gap * 2);
    const right = bounds.right + gap;
    const left = bounds.left - gap - width;
    const side = right + width <= innerWidth - gap ? right : left >= gap ? left : undefined;
    const above = bounds.top - gap * 2;
    const below = innerHeight - bounds.bottom - gap * 2;
    const maxHeight = Math.min(320, side !== undefined ? innerHeight - gap * 2 : Math.max(above, below));
    list.style.width = `${width}px`;
    list.style.maxHeight = `${maxHeight}px`;
    list.style.left = `${side ?? Math.max(gap, Math.min(bounds.left, innerWidth - width - gap))}px`;
    list.style.top = `${side !== undefined ? Math.max(gap, Math.min(bounds.top, innerHeight - maxHeight - gap))
      : above >= below ? bounds.top - gap : bounds.bottom + gap}px`;
    list.style.translate = side === undefined && above >= below ? "0 -100%" : "";
  });
  list.addEventListener("toggle", () => {
    if (!isOpen() || active !== -1) return;
    options[selected]?.scrollIntoView({ block: "nearest" });
  });

  trigger.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const { key } = event;
    if (key === "Tab") {
      if (isOpen()) list.hidePopover();
      return;
    }
    if (key === "Escape" && isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      list.hidePopover();
    } else if ((key === "Enter" || key === " ") && isOpen()) {
      event.preventDefault();
      accept(active === -1 ? selected : active);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      const wasOpen = isOpen();
      if (!wasOpen) list.showPopover();
      const index = active === -1 ? selected : active;
      const next = key === "Home" ? 0 : key === "End" ? options.length - 1
        : !wasOpen && index >= 0 ? index : index + (key === "ArrowDown" ? 1 : -1);
      highlight(Math.max(0, Math.min(options.length - 1, next)), true);
    } else if (key.length === 1 && key !== " ") {
      event.preventDefault();
      if (!isOpen()) list.showPopover();
      const now = performance.now();
      search = (now - lastKey < 500 ? search : "") + key.toLowerCase();
      lastKey = now;
      const match = choices.findIndex(([, name]) => name.toLowerCase().startsWith(search));
      if (match >= 0) highlight(match, true);
    }
  });

  setChoices(choices, value);
  return { field, setChoices };
}
