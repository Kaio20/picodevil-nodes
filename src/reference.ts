import data from "virtual:reference-data";
import { renderReferenceMarkdown } from "./reference-markdown";
import { highlightJsToHtml, injectHighlightCss } from "./highlight-code";
import { definition, nodeKinds, referenceNode, type NodeKind, type NodeMode } from "./node-graph";
import { attachNodeDrag } from "./node-sidebar-drag";

export type RefEntry = (typeof data)[number]["entries"][number] & { node?: NodeKind };

const nodeEntries = new Map<NodeKind, RefEntry>();
for (const kind of nodeKinds) {
  const { label, help, reference, modes } = definition(kind);
  if (help && !reference && !modes) {
    nodeEntries.set(kind, { name: label, description: help, params: [], examples: [], aliases: [], isMethod: false, node: kind });
  }
}
const entries = data.flatMap(category => category.entries);
const categoryColors = {
  Sources: "#5ba8ff", Patterns: "#beeb71", Playback: "#f68f37", Image: "#25e2cd",
  Layout: "#ffe737", Text: "#a675fe", Signals: "#20b562", Media: "#ff82ce",
  Output: "#e03c28", Nodes: "#cf3c71",
} as const;
type Category = keyof typeof categoryColors;

const referenceGroups: Partial<Record<string, Category>> = {
  Sources: "Sources", Effects: "Image", Controls: "Image", Layout: "Layout", Indexing: "Layout",
  Audio: "Signals", Widgets: "Signals", Signals: "Signals", "Signals (Strudel)": "Signals",
  Media: "Media", Global: "Output",
};
const playback = new Set("speed begin end start duration dur scrub rolling sync fit loopat slice splice chop segment".split(" "));
const layout = new Set("grid gridmod circle circlemod tile echo x y width height size scale scalex scaley rotate rotatex rotatey rotatez i count rows cols rowscols radius startoffset circlecount".split(" "));
const categories = Object.entries(categoryColors).map(([name, color]) => ({ name, color, entries: [] as RefEntry[] }));
const byCategory = new Map(categories.map(group => [group.name, group]));
for (const source of data) {
  for (const entry of source.entries) {
    const name = entry.name.toLowerCase();
    const category = playback.has(name) ? "Playback"
      : layout.has(name) ? "Layout"
      : name === "text" || name.startsWith("font") ? "Text"
      : referenceGroups[source.name] ?? "Patterns";
    byCategory.get(category)!.entries.push(entry);
  }
}
byCategory.get("Nodes")!.entries.push(...nodeEntries.values());

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
  searchBox.type = "search";
  searchBox.placeholder = "search…";
  searchBox.className = "ref-search";
  searchBox.setAttribute("aria-label", "Search reference");
  navCol.appendChild(searchBox);

  const nav = document.createElement("nav");
  nav.className = "ref-nav";
  nav.setAttribute("aria-label", "Reference categories");

  const detail = document.createElement("div");
  detail.className = "ref-detail";
  detail.tabIndex = 0;
  detail.setAttribute("role", "region");
  detail.setAttribute("aria-label", "Reference documentation");
  const empty = document.createElement("p");
  empty.className = "ref-empty";
  empty.textContent = "No matching functions.";
  empty.setAttribute("role", "status");
  empty.hidden = true;
  detail.appendChild(empty);

  let current: HTMLElement | undefined;
  const groups = categories.filter(category => category.entries.length).map(cat => {
    const marker = document.createElement("div");
    marker.setAttribute("aria-hidden", "true");
    const navHead = document.createElement("div");
    navHead.className = "ref-nav-head";
    navHead.style.setProperty("--ref-category-color", cat.color);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ref-nav-toggle";
    toggle.setAttribute("aria-label", `Toggle ${cat.name}`);
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "ref-nav-jump";
    jump.textContent = cat.name;
    jump.setAttribute("aria-label", `Go to ${cat.name}`);
    navHead.append(toggle, jump);
    const navItems = document.createElement("div");
    navItems.className = "ref-nav-items";
    navItems.id = `ref-nav-${cat.name.toLowerCase()}`;
    navItems.style.setProperty("--ref-category-color", cat.color);
    toggle.setAttribute("aria-controls", navItems.id);
    nav.append(marker, navHead, navItems);

    const section = document.createElement("section");
    const detailHead = document.createElement("h3");
    detailHead.textContent = cat.name;
    detailHead.id = `ref-cat-${cat.name.replace(/\W/g, "")}`;
    detailHead.className = "ref-detail-head";
    section.appendChild(detailHead);
    detail.appendChild(section);

    const rows = cat.entries.map(entry => {
      const entryId = entry.node ? `ref-node-${entry.node}` : `ref-${entry.name}`;
      const displayName = entry.node ? entry.name : `${entry.name}()`;

      const navLink = document.createElement("a");
      navLink.textContent = displayName;
      navLink.href = `#${entryId}`;
      navLink.className = "ref-nav-link";
      navLink.addEventListener("click", (e) => {
        e.preventDefault();
        show(entry, linkScrollBehavior());
      });
      navItems.appendChild(navLink);

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

      section.appendChild(entryEl);

      const query = [displayName, entry.name, cat.name, ...entry.aliases, entry.description].join(" ").toLowerCase();
      return { entry, query, navLink, detailEntry: entryEl };
    });
    const group = { marker, navHead, toggle, navItems, section, detailHead, rows, expanded: true };
    toggle.addEventListener("click", () => {
      expand(group, navItems.hidden);
      if (!navItems.hidden) scrollNavTo(group);
    });
    jump.addEventListener("click", () => {
      current?.removeAttribute("aria-current");
      current = undefined;
      expand(group, true);
      scrollNavTo(group);
      scrollDetailTo(detailHead, linkScrollBehavior());
    });
    return group;
  });

  type Group = (typeof groups)[number];
  type ScrollAnchor = { group: Group; detailEntry: HTMLElement; navLink?: HTMLAnchorElement };
  const filterItems = new Map(groups.flatMap(group => group.rows.map(row => [row.entry, { group, row }] as const)));
  let anchors: ScrollAnchor[] = [];

  function setExpanded(group: Group, expanded: boolean) {
    group.navItems.hidden = !expanded;
    group.toggle.setAttribute("aria-expanded", String(expanded));
  }

  function expand(group: Group, expanded: boolean) {
    if (!searchBox.value.trim()) group.expanded = expanded;
    setExpanded(group, expanded);
  }

  function scrollNavTo(group: Group, link?: HTMLAnchorElement) {
    const row = !group.navItems.hidden && link;
    const target = row || group.marker;
    const dockedTop = parseFloat(getComputedStyle(group.navHead).top) || 0;
    const offset = dockedTop + (row ? group.navHead.offsetHeight : 0);
    nav.scrollTop += target.getBoundingClientRect().top - nav.getBoundingClientRect().top - offset;
  }

  function scrollDetailTo(target: HTMLElement, behavior: ScrollBehavior) {
    const top = detail.scrollTop + target.getBoundingClientRect().top - detail.getBoundingClientRect().top;
    detail.scrollTo({ top: top - 8, behavior });
  }

  function linkScrollBehavior(): ScrollBehavior {
    return matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
  }

  function followDetail() {
    if (!anchors.length || !detail.clientHeight) return;
    const top = detail.getBoundingClientRect().top + 9;
    let first = 0;
    let last = anchors.length - 1;
    while (first < last) {
      const middle = Math.ceil((first + last) / 2);
      if (anchors[middle].detailEntry.getBoundingClientRect().top <= top) first = middle;
      else last = middle - 1;
    }
    const { group, navLink } = anchors[first];
    scrollNavTo(group, navLink);
  }

  function show(entry: RefEntry, behavior: ScrollBehavior = "instant") {
    const item = filterItems.get(entry);
    if (!item) return;
    const { group, row: { detailEntry, navLink } } = item;
    if (detailEntry.hidden) {
      searchBox.value = "";
      filter();
    }
    if (group.navItems.hidden) expand(group, true);
    current?.removeAttribute("aria-current");
    current = navLink;
    current.setAttribute("aria-current", "location");
    scrollNavTo(group, navLink);
    scrollDetailTo(detailEntry, behavior);
  }

  function filter() {
    const term = searchBox.value.toLowerCase().trim();
    const visible = groups.filter(group => {
      for (const { query, navLink, detailEntry } of group.rows) {
        navLink.hidden = detailEntry.hidden = !query.includes(term);
      }
      const hide = group.rows.every(row => row.navLink.hidden);
      group.marker.hidden = group.navHead.hidden = group.section.hidden = hide;
      setExpanded(group, !hide && (Boolean(term) || group.expanded));
      return !hide;
    });
    visible.forEach(({ navHead }, index) => {
      navHead.style.setProperty("--ref-before", String(index));
      navHead.style.setProperty("--ref-after", String(visible.length - index - 1));
    });
    anchors = visible.flatMap(group => [
      { group, detailEntry: group.detailHead },
      ...group.rows.filter(row => !row.detailEntry.hidden).map(({ detailEntry, navLink }) => ({ group, detailEntry, navLink })),
    ]);
    empty.hidden = visible.length > 0;
    nav.scrollTop = detail.scrollTop = 0;
  }
  searchBox.addEventListener("input", filter);
  detail.addEventListener("scroll", followDetail);

  navCol.appendChild(nav);
  wrap.append(navCol, detail);
  container.replaceChildren(wrap);
  filter();
  return show;
}
