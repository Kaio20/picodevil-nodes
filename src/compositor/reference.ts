import { catalog, descriptions, groups, type Drop } from "./catalog";
import { kinds, nodes, typeNames, type Kind } from "./graph";

const usage: Record<Kind, string> = {
  video: "Choose a clip with Source or drag a clip from Videos onto the graph. Connect the image to Merge, an image effect, or Output. A clip shared between draft and live keeps playing through a Take.",
  texture: "Choose an image from a collection or import one under Textures. Connect it to an image input, or use its luminance to drive a Mask or Factor input.",
  audio: "Enable the microphone in Audio and choose Level, Bass, Mid, or Treble. Connect the signal to a numeric input such as Merge’s Factor. The signal is zero while the microphone is off.",
  output: "Connect the last image in your graph here. Use View Output to inspect the draft and Take to publish it to the separate live window.",
  merge: "Connect one image to Background and another to Foreground. Normal uses the foreground alpha. Multiply darkens their overlap and Screen lightens it. Factor at zero shows the background, and at one applies the full foreground according to its alpha.",
  mask: "White keeps the image and black makes it transparent. Gray keeps part of its coverage. Connect Alpha for a transparency mask, or Noise through a Color Ramp for a procedural mask.",
  alpha: "Opaque pixels produce 1 and transparent pixels produce 0. Feed this result to Apply Mask or a blend Factor when you want transparency to control the effect.",
  displace: "Connect a Vector to Offset for separate horizontal and vertical shifts. A Float feeds the same value to both axes. Start with a small Strength such as 0.05 and animate it with an LFO or Step Sequencer.",
  junction: "Double-click a cable to add a Reroute, then drag its output to branch the signal. The original socket type travels through it, so conversions still happen at the destination.",
  value: "Edit the number directly on the node. Choose Integer for whole numbers. Integer values convert automatically when connected to Float inputs.",
  boolean: "Use the checkbox to choose a state. Connect it to a Switch condition or a Float socket, where false and true become 0 and 1.",
  switch: "Connect a Boolean to Condition. False and True define the result for each state. A connected Float counts as true when it is nonzero.",
  color: "Pick the color and set its alpha. A connection to an Image socket produces a solid fill; a connection to a numeric Factor uses luminance weighted by alpha.",
  mixColor: "Choose or connect two colors. Factor at zero yields A and at one yields B. Connect a spatial signal to vary the mix across the image.",
  uv: "The vector runs from the top-left (0, 0) to the bottom-right (1, 1). Feed it to Noise or use it as the basis of a coordinate effect.",
  vector: "Connect or enter the X and Y components separately. Use the result when a node such as Displace needs to treat the axes independently.",
  noise: "Scale controls how tightly the noise varies across the image. The unconnected UV input uses image coordinates. Connect Time for movement, then feed the result to a Color Ramp, Mask, or Displace.",
  math: "Choose an operation, then enter or connect A and B. Operations work on single values and per-pixel fields. Greater Than produces 1 when A exceeds B and 0 otherwise.",
  ramp: "Choose two colors and their positions. The factor selects a color along the ramp. Move the stops closer together for a sharper transition, for example when shaping a mask from Noise.",
  expression: "Open Edit WGSL and enter one Float expression, such as sin(time * a + uv.x * b). The Float sockets provide a and b, while uv and time come from the graph runtime.",
  time: "Seconds increases continuously, Beats follows the transport and Beat Phase returns to zero at each beat. Feed Seconds to Noise or Beat Phase to an effect that repeats every beat.",
  lfo: "Choose a sine, triangle, or saw waveform. A rate of 0.25 cycles per beat gives one cycle every four beats. Connect the output to a control you want to animate smoothly.",
  steps: "Open Edit Steps to set the value of each step. At two steps per beat, eight steps repeat every four beats. Connect the output to a control that should jump between values.",
};

const related: Partial<Record<Kind, Kind[]>> = {
  video: ["merge", "output"], texture: ["mask", "ramp"], output: ["merge"], merge: ["mask", "alpha"],
  mask: ["alpha", "ramp"], alpha: ["mask"], displace: ["vector", "noise", "steps"], junction: ["output"],
  audio: ["math", "merge"], noise: ["time", "ramp", "displace"], ramp: ["noise", "mask"],
  expression: ["uv", "time"], steps: ["lfo", "displace"], lfo: ["time", "steps"],
};


function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function link(kind: Kind, className: string) {
  const anchor = make("a", className, nodes[kind].label);
  anchor.href = `#reference-${kind}`;
  anchor.dataset.reference = kind;
  return anchor;
}

function position(pane: HTMLElement, item: HTMLElement) {
  return pane.scrollTop + item.getBoundingClientRect().top - pane.getBoundingClientRect().top;
}

export function setupReference(container: HTMLElement, add: (drop: Drop) => void, draggable: (element: HTMLElement, drop: Drop) => void) {
  const search = container.querySelector<HTMLInputElement>("#reference-search")!;
  const nav = container.querySelector<HTMLElement>("#reference-groups")!;
  const detail = container.querySelector<HTMLElement>("#reference-details")!;
  const entries = new Map<Kind, { anchor: HTMLAnchorElement; article: HTMLElement }>();
  const empty = make("p", "reference-empty", "No matching nodes.");
  empty.setAttribute("role", "status");
  detail.append(empty);
  let term = "";
  let active: HTMLElement | undefined;
  let requestedScroll: number | undefined;

  const sections = groups.map(name => {
    const marker = make("div", "reference-marker");
    marker.setAttribute("aria-hidden", "true");
    const header = make("div", "reference-category");
    header.dataset.group = name;
    const toggle = make("button", "reference-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-label", `Toggle ${name}`);
    const jump = make("button", "reference-jump", name);
    jump.type = "button";
    header.append(toggle, jump);
    const body = make("div", "reference-node-list");
    body.dataset.group = name;
    body.id = `reference-list-${name.toLowerCase()}`;
    toggle.setAttribute("aria-controls", body.id);
    const section = make("section", "reference-section");
    section.dataset.group = name;
    section.append(make("h2", "reference-section-title", name));
    const rows = kinds.filter(kind => nodes[kind].group === name).map(kind => {
      const def = nodes[kind];
      const anchor = link(kind, "reference-node-link");
      anchor.title = def.label;
      draggable(anchor, { kind });
      body.append(anchor);

      const article = make("article", "reference-entry");
      article.id = `reference-${kind}`;
      article.tabIndex = -1;
      const head = make("div", "reference-entry-head");
      head.append(make("h3", "", def.label));
      if (kind !== "output") {
        const insert = make("button", "quiet", "+");
        insert.type = "button";
        insert.title = `Add ${def.label}`;
        insert.setAttribute("aria-label", insert.title);
        insert.addEventListener("click", () => add({ kind }));
        draggable(insert, { kind });
        head.append(insert);
      }
      article.append(head, make("p", "", descriptions[kind]), make("p", "", usage[kind]));
      const connections = make("dl", "reference-connections");
      const inputs = Object.values(def.inputs).map(socket => `${socket.label} (${typeNames[socket.type]})`);
      if (inputs.length) connections.append(make("dt", "", "Inputs"), make("dd", "", kind === "junction" ? "Any socket type" : inputs.join(", ")));
      const output = kind === "junction" ? "Same type as the input" : kind === "value" ? "Float or Integer" : typeNames[def.output];
      if (kind !== "output") connections.append(make("dt", "", "Output"), make("dd", "", output));
      article.append(connections);
      const links = related[kind];
      if (links) {
        const see = make("p", "reference-related");
        see.append(make("span", "", "See also"), ...links.map(other => link(other, "reference-inline-link")));
        article.append(see);
      }
      section.append(article);
      entries.set(kind, { anchor, article });
      return { kind, anchor, article };
    });
    const group = { marker, header, toggle, jump, body, section, rows, collapsed: false };
    toggle.addEventListener("click", () => {
      const expanded = body.hidden;
      if (!term) group.collapsed = !expanded;
      showGroup(group, expanded);
    });
    jump.addEventListener("click", () => {
      if (!term) group.collapsed = false;
      showGroup(group, true);
      setActive(jump);
      alignNav(group, marker);
      scrollDetail(section);
    });
    nav.append(marker, header, body);
    detail.append(section);
    return group;
  });

  function showGroup(group: typeof sections[number], expanded: boolean) {
    group.body.hidden = !expanded;
    group.toggle.setAttribute("aria-expanded", String(expanded));
  }

  function setActive(item?: HTMLElement) {
    if (item === active) return;
    active?.removeAttribute("aria-current");
    active = item;
    active?.setAttribute("aria-current", "location");
  }

  function alignNav(group: typeof sections[number], item: HTMLElement) {
    const reserved = Number.parseFloat(getComputedStyle(group.header).top) || 0;
    nav.scrollTop = position(nav, item) - reserved - (item === group.marker ? 0 : group.header.offsetHeight + 3);
  }

  function scrollDetail(item: HTMLElement) {
    detail.scrollTop = position(detail, item) - 7;
    requestedScroll = detail.scrollTop;
  }

  function filter() {
    term = search.value.toLowerCase().trim();
    const matches = new Set(catalog(kinds, term).map(choice => choice.kind));
    const visible = sections.filter(group => {
      for (const { kind, anchor, article } of group.rows) {
        anchor.hidden = article.hidden = Boolean(term && !matches.has(kind) && !`${descriptions[kind]} ${usage[kind]}`.toLowerCase().includes(term));
      }
      const hidden = group.rows.every(row => row.article.hidden);
      group.marker.hidden = group.header.hidden = group.section.hidden = hidden;
      showGroup(group, !hidden && (Boolean(term) || !group.collapsed));
      return !hidden;
    });
    visible.forEach(({ header }, index) => {
      header.style.setProperty("--before", String(index));
      header.style.setProperty("--after", String(visible.length - 1 - index));
    });
    empty.hidden = visible.length > 0;
    setActive(undefined);
    nav.scrollTop = detail.scrollTop = 0;
    requestedScroll = 0;
  }

  function show(kind: Kind, focus = false) {
    const entry = entries.get(kind);
    if (!entry) return;
    if (entry.article.hidden) {
      search.value = "";
      filter();
    }
    const group = sections.find(group => group.body.contains(entry.anchor))!;
    if (!term) group.collapsed = false;
    showGroup(group, true);
    setActive(entry.anchor);
    alignNav(group, entry.anchor);
    scrollDetail(entry.article);
    if (focus) entry.article.focus({ preventScroll: true });
  }

  container.addEventListener("click", event => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[data-reference]");
    if (!anchor) return;
    event.preventDefault();
    show(anchor.dataset.reference as Kind, true);
  });
  detail.addEventListener("scroll", () => {
    if (requestedScroll !== undefined && Math.abs(detail.scrollTop - requestedScroll) < 2) return;
    requestedScroll = undefined;
    const visible = [...entries.values()].filter(entry => !entry.article.hidden);
    const top = detail.getBoundingClientRect().top;
    const above = visible.filter(entry => entry.article.getBoundingClientRect().top <= top + 12);
    const atEnd = detail.scrollHeight - detail.clientHeight - detail.scrollTop < 2;
    setActive((atEnd ? visible.at(-1) : above.at(-1) ?? visible[0])?.anchor);
  }, { passive: true });
  search.addEventListener("input", filter);
  filter();
  return show;
}
