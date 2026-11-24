import data from "virtual:reference-data";
import { renderReferenceMarkdown } from "./reference-markdown";
import { highlightJsToHtml, injectHighlightCss } from "./highlight-code";
import { definition, nodeKinds, referenceNode, type NodeKind, type NodeMode } from "./node-graph";
import { attachNodeDrag } from "./node-sidebar-drag";

export type RefEntry = (typeof data)[number]["entries"][number] & { node?: NodeKind };

interface RefCategory {
  name: string;
  entries: RefEntry[];
}

const nodeEntries = new Map<NodeKind, RefEntry>();
for (const kind of nodeKinds) {
  const { label, help, reference, modes } = definition(kind);
  if (help && !reference && !modes) {
    nodeEntries.set(kind, { name: label, description: help, params: [], examples: [], aliases: [], isMethod: false, node: kind });
  }
}
const categories: RefCategory[] = [...data, { name: "Nodes", entries: [...nodeEntries.values()] }];
const entries = data.flatMap(category => category.entries);

export function referenceForNode(kind: NodeKind, mode?: NodeMode) {
  const def = definition(kind);
  let entry = nodeEntries.get(kind);
  for (const name of mode?.reference ?? def.reference ?? []) {
    entry = entries.find(item => item.name === name) ?? entries.find(item => item.aliases.includes(name));
    if (entry) break;
  }
  const description = mode?.help ?? def.help ?? entry?.description.split(/\r?\n\s*\r?\n/, 1)[0];
  const summary = description?.replace(/`|\*\*/g, "").replace(/\s+/g, " ").trim();
  return { entry, summary };
}

export function setupReference(container: HTMLElement) {
  injectHighlightCss();

  const wrap = document.createElement("div");
  wrap.className = "ref-wrap";

  const navCol = document.createElement("div");
  navCol.className = "ref-nav-col";

  const searchBox = document.createElement("input");
  searchBox.type = "text";
  searchBox.placeholder = "search…";
  searchBox.className = "ref-search";
  navCol.appendChild(searchBox);

  const nav = document.createElement("div");
  nav.className = "ref-nav";

  const detail = document.createElement("div");
  detail.className = "ref-detail";

  // Track all elements for filtering
  const filterItems = new Map<RefEntry, { query: string; navLink: HTMLElement; detailEntry: HTMLElement; cat: string }>();
  const catNavHeads = new Map<string, HTMLElement>();
  const catDetailHeads = new Map<string, HTMLElement>();
  let current: HTMLElement | undefined;

  const show = (entry: RefEntry, behavior: ScrollBehavior = "instant") => {
    const item = filterItems.get(entry);
    if (!item) return;
    const { detailEntry, navLink } = item;
    if (detailEntry.style.display === "none") {
      searchBox.value = "";
      filter();
    }
    current?.removeAttribute("aria-current");
    current = navLink;
    current.setAttribute("aria-current", "location");
    const top = detail.scrollTop + detailEntry.getBoundingClientRect().top - detail.getBoundingClientRect().top;
    detail.scrollTo({ top: top - 8, behavior });
  };

  for (const cat of categories) {
    const navHead = document.createElement("div");
    navHead.textContent = cat.name;
    navHead.className = "ref-nav-head";
    nav.appendChild(navHead);
    catNavHeads.set(cat.name, navHead);

    const detailHead = document.createElement("h3");
    detailHead.textContent = cat.name;
    detailHead.id = `ref-cat-${cat.name.replace(/\W/g, "")}`;
    detailHead.className = "ref-detail-head";
    detail.appendChild(detailHead);
    catDetailHeads.set(cat.name, detailHead);

    for (const entry of cat.entries) {
      const entryId = entry.node ? `ref-node-${entry.node}` : `ref-${entry.name}`;
      const displayName = entry.node ? entry.name : `${entry.name}()`;

      const navLink = document.createElement("a");
      navLink.textContent = displayName;
      navLink.href = `#${entryId}`;
      navLink.className = "ref-nav-link";
      navLink.addEventListener("click", (e) => {
        e.preventDefault();
        show(entry, "smooth");
      });
      nav.appendChild(navLink);

      const entryEl = document.createElement("div");
      entryEl.id = entryId;
      entryEl.className = "ref-entry";

      const sig = entry.params.length ? `${entry.name}(...)` : displayName;
      const nameEl = document.createElement("div");
      nameEl.className = "ref-entry-name";
      nameEl.textContent = sig;
      const drop = entry.node ? { kind: entry.node } : referenceNode(entry.name, entry.aliases);
      if (drop) {
        attachNodeDrag(navLink, drop);
        attachNodeDrag(nameEl, drop);
      }
      if (entry.aliases.length) {
        const aliasSpan = document.createElement("span");
        aliasSpan.className = "ref-entry-aliases";
        aliasSpan.textContent = `aliases: ${entry.aliases.map((a) => `${a}()`).join(", ")}`;
        nameEl.appendChild(aliasSpan);
      }
      entryEl.appendChild(nameEl);

      const descEl = document.createElement("div");
      descEl.className = "ref-entry-desc";
      // Descriptions use a small markdown subset (paragraphs, bullet lists,
      // inline `code`). renderReferenceMarkdown escapes HTML and the input is
      // our own build-time JSDoc, so assigning innerHTML is safe here.
      descEl.innerHTML = renderReferenceMarkdown(entry.description);
      entryEl.appendChild(descEl);

      if (entry.params.length) {
        const paramsEl = document.createElement("div");
        paramsEl.className = "ref-entry-params";
        paramsEl.textContent = entry.params.join(" | ");
        entryEl.appendChild(paramsEl);
      }

      for (const ex of entry.examples) {
        const exEl = document.createElement("pre");
        exEl.className = "ref-entry-example";
        // Reuse the editor's JS syntax highlighting. highlightJsToHtml escapes
        // HTML and the input is our own build-time examples, so innerHTML is safe.
        exEl.innerHTML = highlightJsToHtml(ex);
        entryEl.appendChild(exEl);
      }

      detail.appendChild(entryEl);

      const queryText = [displayName, entry.name, ...entry.aliases, entry.description].join(" ").toLowerCase();
      filterItems.set(entry, { query: queryText, navLink, detailEntry: entryEl, cat: cat.name });
    }
  }

  // Filter logic
  function filter() {
    const term = searchBox.value.toLowerCase().trim();
    const visibleCats = new Set<string>();

    for (const item of filterItems.values()) {
      const match = !term || item.query.includes(term);
      item.navLink.style.display = match ? "" : "none";
      item.detailEntry.style.display = match ? "" : "none";
      if (match) visibleCats.add(item.cat);
    }

    for (const [catName, el] of catNavHeads) {
      el.style.display = visibleCats.has(catName) ? "" : "none";
    }
    for (const [catName, el] of catDetailHeads) {
      el.style.display = visibleCats.has(catName) ? "" : "none";
    }
  }
  searchBox.addEventListener("input", filter);

  navCol.appendChild(nav);
  wrap.appendChild(navCol);
  wrap.appendChild(detail);
  container.innerHTML = "";
  container.appendChild(wrap);
  return show;
}
