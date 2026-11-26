import { categoryColors, getReference, parametersFor, referenceCategories, referenceDragType, signature, type CodeFragment, type ReferenceEntry } from "./editor-catalog";
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

function referenceLink(name: string, className: string, text?: string) {
  const link = el("a", className, text);
  link.href = `#ref-${name}`;
  link.dataset.reference = name;
  return link;
}

function scrollTopFor(pane: HTMLElement, target: HTMLElement) {
  return pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top;
}

function renderEntry(entry: ReferenceEntry, insert: (fragment: CodeFragment) => void) {
  const article = el("article", "ref-entry");
  article.id = `ref-${entry.name}`;
  article.tabIndex = -1;
  article.style.setProperty("--pd-category", categoryColors[entry.category]);
  const title = el("header", "ref-entry-title");
  title.append(el("h3", "ref-entry-name", signature(entry)), insertButton(`Insert ${entry.name}`, entry.fragment, insert));
  article.append(title);
  if (entry.aliases.length) article.append(el("div", "ref-entry-aliases", `Aliases: ${entry.aliases.join(", ")}`));

  const description = el("div", "ref-entry-desc");
  description.innerHTML = renderReferenceMarkdown(entry.description.replace(/\{@link\s+([\w$]+)\}/g, "`$1`"));
  for (const code of description.querySelectorAll("code")) {
    const match = /^\.?([\w$]+)(?:\([^()]*\))?$/.exec(code.textContent.trim());
    const target = match && getReference(match[1], false);
    if (!target || target === entry) continue;
    const link = referenceLink(target.name, "ref-prose-link");
    code.replaceWith(link);
    link.append(code);
  }
  article.append(description);
  for (const param of parametersFor(entry, entry.isMethod)) {
    const line = el("div", "ref-entry-params");
    line.append(el("code", "", param.name), param.description ? ` — ${param.description}` : "");
    article.append(line);
  }
  for (const example of entry.examples) {
    const fragment: CodeFragment = { kind: "example", text: example };
    const demo = el("div", "ref-example-row");
    const pre = el("pre", "ref-entry-example");
    pre.innerHTML = highlightJsToHtml(example);
    draggable(pre, fragment);
    demo.append(pre, insertButton(`Insert ${entry.name} example`, fragment, insert));
    article.append(demo);
  }
  return article;
}

export function setupReference(container: HTMLElement, insert: (fragment: CodeFragment) => void) {
  injectHighlightCss();
  const wrap = el("div", "ref-wrap");
  const navCol = el("div", "ref-nav-col");
  const search = el("input", "ref-search");
  search.type = "search";
  search.placeholder = "search…";
  search.setAttribute("aria-label", "Search reference");
  const nav = el("nav", "ref-nav");
  nav.setAttribute("aria-label", "Reference functions");
  navCol.append(search, nav);
  const detail = el("div", "ref-detail");
  detail.tabIndex = 0;
  detail.setAttribute("role", "region");
  detail.setAttribute("aria-label", "Reference documentation");
  const empty = el("p", "ref-empty", "No matching functions.");
  empty.hidden = true;
  empty.setAttribute("role", "status");
  detail.append(empty);
  wrap.append(navCol, detail);

  const links = new Map<string, { link: HTMLAnchorElement; article: HTMLElement }>();
  let active: HTMLElement | undefined;
  let term = "";
  const groups = referenceCategories.map(({ name, entries }) => {
    // The marker stays in the document flow when the header docks.
    const marker = el("div", "ref-category-marker");
    marker.setAttribute("aria-hidden", "true");
    const header = el("div", "ref-category");
    header.style.setProperty("--pd-category", categoryColors[name]);
    const toggle = el("button", "ref-category-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-label", `Toggle ${name}`);
    const jump = el("button", "ref-category-jump", name);
    jump.type = "button";
    header.append(toggle, jump);
    const body = el("div", "ref-category-body");
    body.id = `ref-nav-${name.toLowerCase()}`;
    body.style.setProperty("--pd-category", categoryColors[name]);
    toggle.setAttribute("aria-controls", body.id);
    const section = el("section", "ref-detail-section");
    section.append(el("h2", "ref-detail-head", name));
    const rows = entries.map(entry => {
      const link = referenceLink(entry.name, "ref-nav-link", entry.constant ? entry.name : `${entry.name}()`);
      link.title = signature(entry);
      draggable(link, entry.fragment);
      body.append(link);
      const article = renderEntry(entry, insert);
      section.append(article);
      links.set(entry.name, { link, article });
      const params = entry.params.map(param => `${param.name} ${param.description}`);
      const query = [entry.name, name, entry.description, ...entry.aliases, ...params].join(" ").toLowerCase();
      return { link, article, query };
    });
    const group = { marker, header, toggle, jump, body, section, rows, collapsed: false };
    toggle.addEventListener("click", () => {
      rememberView();
      const expanded = body.hidden;
      setExpanded(group, expanded);
      toggle.focus({ preventScroll: true });
    });
    jump.addEventListener("click", () => {
      rememberView();
      setExpanded(group, true);
      setActive(jump);
      jump.focus({ preventScroll: true });
      const dockedTop = Number.parseFloat(getComputedStyle(header).top) || 0;
      nav.scrollTop = scrollTopFor(nav, marker) - dockedTop;
      detail.scrollTop = scrollTopFor(detail, section) - 6;
    });
    nav.append(marker, header, body);
    detail.append(section);
    return group;
  });

  type Group = (typeof groups)[number];
  const history: {
    search: string;
    navTop: number;
    detailTop: number;
    active?: HTMLElement;
    groups: { collapsed: boolean; expanded: boolean }[];
  }[] = [];

  function showGroup({ body, toggle }: Group, expanded: boolean) {
    body.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
  }

  function setExpanded(group: Group, expanded: boolean) {
    if (!term) group.collapsed = !expanded;
    showGroup(group, expanded);
  }

  function setActive(next?: HTMLElement) {
    active?.removeAttribute("aria-current");
    active = next;
    active?.setAttribute("aria-current", "location");
  }

  function rememberView() {
    if (history.length === 50) history.shift();
    history.push({
      search: search.value,
      navTop: nav.scrollTop,
      detailTop: detail.scrollTop,
      active,
      groups: groups.map(group => ({ collapsed: group.collapsed, expanded: !group.body.hidden })),
    });
  }

  function filter() {
    term = search.value.toLowerCase().trim().replace(/^\./, "").replace(/\(\)$/, "");
    const visible = groups.filter(group => {
      const { marker, header, section, rows, collapsed } = group;
      for (const { link, article, query } of rows) link.hidden = article.hidden = !query.includes(term);
      const hide = rows.every(({ article }) => article.hidden);
      marker.hidden = header.hidden = section.hidden = hide;
      showGroup(group, !hide && (!!term || !collapsed));
      return !hide;
    });
    visible.forEach(({ header }, index) => {
      header.style.setProperty("--pd-before", String(index));
      header.style.setProperty("--pd-after", String(visible.length - index - 1));
    });
    empty.hidden = visible.length > 0;
    nav.scrollTop = detail.scrollTop = 0;
  }

  wrap.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.target === search || !(event.ctrlKey || event.metaKey) ||
        event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return;
    const previous = history.pop();
    if (!previous) return;
    event.preventDefault();
    search.value = previous.search;
    groups.forEach((group, index) => { group.collapsed = previous.groups[index].collapsed; });
    filter();
    groups.forEach((group, index) => showGroup(group, previous.groups[index].expanded));
    setActive(previous.active);
    previous.active?.focus({ preventScroll: true });
    nav.scrollTop = previous.navTop;
    detail.scrollTop = previous.detailTop;
  });

  wrap.addEventListener("click", event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[data-reference]");
    if (!link) return;
    const target = links.get(link.dataset.reference!);
    if (!target) return;
    event.preventDefault();
    rememberView();
    if (target.article.hidden) {
      search.value = "";
      filter();
    }
    setActive(target.link);
    target.article.focus({ preventScroll: true });
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    detail.scrollTo({ top: scrollTopFor(detail, target.article) - 6, behavior });
  });
  search.addEventListener("input", filter);
  filter();
  container.replaceChildren(wrap);
}
