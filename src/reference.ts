import { categoryColors, parametersFor, referenceCategories, referenceDragType, signature, type CodeFragment } from "./editor-catalog";
import { renderReferenceMarkdown } from "./reference-markdown";
import { highlightJsToHtml, injectHighlightCss } from "./highlight-code";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

function draggable(element: HTMLElement, fragment: CodeFragment) {
  element.draggable = true;
  element.addEventListener("dragstart", event => {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(referenceDragType, JSON.stringify(fragment));
    event.dataTransfer.setData("text/plain", fragment.text);
  });
}

function insertButton(label: string, fragment: CodeFragment, insert: (fragment: CodeFragment) => void) {
  const button = el("button", "ref-insert", "＋");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  draggable(button, fragment);
  button.addEventListener("click", () => insert(fragment));
  return button;
}

export function setupReference(container: HTMLElement, insert: (fragment: CodeFragment) => void) {
  injectHighlightCss();
  const wrap = el("div", "ref-wrap");
  const toolbar = el("div", "ref-toolbar");
  const search = el("input", "ref-search");
  search.type = "search";
  search.placeholder = "Find a function, effect or pattern…";
  search.setAttribute("aria-label", "Search reference");
  const hint = el("small", "ref-hint", "Drag a function into the editor or use ＋.");
  toolbar.append(search, hint);
  const list = el("div", "ref-list");
  list.setAttribute("aria-label", "Reference categories");
  const empty = el("p", "ref-empty", "No matching functions.");
  empty.hidden = true;
  wrap.append(toolbar, list, empty);

  const groups = referenceCategories.map(({ name, entries }) => {
    // A marker keeps the natural scroll position while the heading is docked.
    const marker = el("div", "ref-marker");
    const header = el("button", "ref-category", name);
    header.type = "button";
    header.style.setProperty("--pd-category", categoryColors[name]);
    header.addEventListener("click", () => {
      const offset = marker.getBoundingClientRect().top - list.getBoundingClientRect().top;
      const top = Number.parseFloat(getComputedStyle(header).top) || 0;
      list.scrollTo({ top: list.scrollTop + offset - top, behavior: "smooth" });
    });
    const body = el("div", "ref-category-body");
    body.style.setProperty("--pd-category", categoryColors[name]);
    const rows = entries.map(entry => {
      const row = el("div", "ref-row");
      const details = el("details", "ref-entry");
      const label = signature(entry);
      const summary = el("summary", "ref-summary");
      summary.append(el("code", "ref-entry-name", label), el("span", "ref-summary-text", entry.summary));
      draggable(summary, entry.fragment);
      details.append(summary);
      details.addEventListener("toggle", () => {
        if (!details.open || details.childElementCount > 1) return;
        const content = el("div", "ref-entry-content");
        const description = el("div", "ref-entry-desc");
        description.innerHTML = renderReferenceMarkdown(entry.description);
        content.append(description);
        if (entry.aliases.length) content.append(el("div", "ref-entry-aliases", `Aliases: ${entry.aliases.join(", ")}`));
        for (const param of parametersFor(entry, entry.isMethod)) {
          const line = el("div", "ref-entry-params");
          line.append(el("code", "", param.name), ` — ${param.description}`);
          content.append(line);
        }
        for (const example of entry.examples) {
          const fragment: CodeFragment = { kind: "example", text: example };
          const demo = el("div", "ref-example-row");
          const pre = el("pre", "ref-entry-example");
          pre.innerHTML = highlightJsToHtml(example);
          draggable(pre, fragment);
          demo.append(pre, insertButton(`Insert ${entry.name} example`, fragment, insert));
          content.append(demo);
        }
        details.append(content);
      });
      row.append(details, insertButton(`Insert ${entry.name}`, entry.fragment, insert));
      body.append(row);
      const query = [entry.name, name, entry.description, ...entry.aliases, ...entry.params.map(param => param.name)].join(" ").toLowerCase();
      return { row, query };
    });
    list.append(marker, header, body);
    return { marker, header, body, rows };
  });

  function filter() {
    const term = search.value.toLowerCase().trim().replace(/^\./, "").replace(/\(\)$/, "");
    const visible = groups.filter(({ marker, header, body, rows }) => {
      for (const { row, query } of rows) row.hidden = !query.includes(term);
      const hide = rows.every(({ row }) => row.hidden);
      marker.hidden = header.hidden = body.hidden = hide;
      return !hide;
    });
    visible.forEach(({ header }, index) => {
      header.style.setProperty("--pd-before", String(index));
      header.style.setProperty("--pd-after", String(visible.length - index - 1));
    });
    empty.hidden = visible.length > 0;
    list.scrollTop = 0;
  }
  search.addEventListener("input", filter);
  filter();
  container.replaceChildren(wrap);
}
