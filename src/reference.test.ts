import { afterEach, describe, expect, it, vi } from "vitest";
import { setupReference } from "./reference";
import type { CodeFragment } from "./editor-catalog";

const host = document.createElement("div");
afterEach(() => {
  host.replaceChildren();
  host.remove();
});

function render(insert: (fragment: CodeFragment) => void = () => {}) {
  document.body.append(host);
  setupReference(host, insert);
  const nav = host.querySelector<HTMLElement>(".ref-nav")!;
  const detail = host.querySelector<HTMLElement>(".ref-detail")!;
  const search = host.querySelector<HTMLInputElement>(".ref-search")!;
  return { nav, detail, search };
}

describe("reference panes", () => {
  it("links the function index to full entries without changing the code URL", () => {
    const { nav, detail } = render();
    const scroll = vi.spyOn(detail, "scrollTo");
    const href = window.location.href;
    const link = nav.querySelector<HTMLAnchorElement>('a[href="#ref-huerot"]')!;
    expect(detail.querySelector("#ref-huerot .ref-entry-example")?.textContent).toContain(".huerot(0.5)");
    link.click();
    expect(scroll).toHaveBeenCalledOnce();
    expect(link.getAttribute("aria-current")).toBe("location");
    expect(window.location.href).toBe(href);
  });

  it("collapses only the index category and reveals results while searching", () => {
    const { nav, detail, search } = render();
    const sources = [...nav.querySelectorAll("button")].find(button => button.textContent === "Sources")!;
    const group = nav.querySelector<HTMLElement>("#ref-nav-sources")!;
    expect(sources.getAttribute("aria-expanded")).toBe("true");
    sources.click();
    expect(sources.getAttribute("aria-expanded")).toBe("false");
    expect(group.hidden).toBe(true);
    expect(detail.querySelector<HTMLElement>("#ref-color")?.hidden).toBe(false);
    search.value = "color";
    search.dispatchEvent(new Event("input"));
    expect(group.hidden).toBe(false);
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(group.hidden).toBe(true);
  });

  it("links references in the prose and keeps insert and drag actions available", () => {
    const insert = vi.fn();
    const { nav, detail } = render(insert);
    const sineLink = detail.querySelector<HTMLAnchorElement>('#ref-sin .ref-entry-desc a[href="#ref-sine"]')!;
    sineLink.click();
    expect(nav.querySelector('a[href="#ref-sine"]')?.getAttribute("aria-current")).toBe("location");
    const example = detail.querySelector<HTMLElement>("#ref-huerot .ref-entry-example")!;
    const data = new DataTransfer();
    example.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data }));
    expect(data.getData("text/plain")).toContain(".huerot(0.5)");
    detail.querySelector<HTMLButtonElement>('#ref-huerot button[aria-label="Insert huerot"]')!.click();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ kind: "method" }));
  });
});
