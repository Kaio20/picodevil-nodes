import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { EditorState } from "@codemirror/state";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { EditorView } from "@codemirror/view";
import { activeArgument, referenceInsertion } from "./editor-assistance";
import { getReference } from "./editor-catalog";
import { color } from "./color-pattern";
import { editorCompletion } from "./editor-completion";
import { argumentBar } from "./editor-argument-bar";
import { runTranspiled } from "./eval-sandbox";
import { transpile } from "./transpiler";

function atCaret(source: string) {
  return EditorState.create({
    doc: source.replace("▮", ""),
    selection: { anchor: source.indexOf("▮") },
    extensions: javascriptLanguage,
  });
}

describe("editor assistance", () => {
  it("finds the innermost call and ignores commas inside nested expressions and strings", () => {
    expect(activeArgument(atCaret('$: color("red").crop(1, f([1, 2]), "a,b", ▮0.5)')))
      .toMatchObject({ name: "crop", index: 3, value: "0.5" });
    expect(activeArgument(atCaret('$: color("red").alpha(sine.range(0, ▮')))
      .toMatchObject({ name: "range", index: 1, value: "" });
    expect(activeArgument(atCaret('color("red").alpha(/* opacity */ ▮0.5)'))?.value).toBe("0.5");
  });

  it("finds documented aliases and curried controls", () => {
    expect(activeArgument(atCaret('$: color("red").opacity(▮0.5)'))?.entry?.name).toBe("alpha");
    expect(activeArgument(atCaret('$: color("red").sometimes(blend("mul▮tiply"))'))?.entry?.name).toBe("blend");
    expect(activeArgument(atCaret('$: s("du▮cks")'))?.entry?.name).toBe("screen");
  });

  it("inserts a method inside the current chain and starts a layer on an empty line", () => {
    const method = getReference("blend", true)!;
    const state = atCaret('$: color("red")▮');
    expect(referenceInsertion(state, state.selection.main, method.fragment).insert).toBe('.blend("source-over")');
    const blank = atCaret("▮");
    expect(referenceInsertion(blank, blank.selection.main, method.fragment).insert).toBe('$: color("#5ba8ff").blend("source-over")');
  });

  it("accepts RGBA literals as solid sources and retains ordinary color patterns", () => {
    const { code } = transpile('color("rgba(255, 0, 0, 0.5)")');
    const result = runTranspiled(code) as ReturnType<typeof color>;
    expect(result.queryArc(0, 1)[0].value)
      .toMatchObject({ color: "rgba(255, 0, 0, 0.5)" });
    expect(color("red blue").queryArc(0, 1).map(hap => hap.value.color)).toEqual(["red", "blue"]);
  });
});

describe("editor controls", () => {
  const host = document.createElement("div");
  let view: EditorView;
  function setup(source: string) {
    document.body.append(host);
    const pos = source.indexOf("▮");
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: source.replace("▮", ""),
        selection: { anchor: pos },
        extensions: [javascriptLanguage, editorCompletion, argumentBar(host)],
      }),
    });
    return view;
  }
  afterEach(() => {
    view.destroy();
    host.replaceChildren();
    host.remove();
  });

  it("previews a completion and accepts it with Tab without inserting a tab character", async () => {
    const editor = setup('$: color("red").▮');
    editor.focus();
    await userEvent.keyboard("alp");
    await expect.poll(() => host.querySelector(".pd-ghost-text")?.textContent).toBe("ha()");
    expect(editor.state.doc.toString()).toBe('$: color("red").alp');
    await userEvent.keyboard("{Tab}");
    expect(editor.state.doc.toString()).toBe('$: color("red").alpha()');
    expect(host.querySelector(".pd-current-parameter")?.textContent).toBe("value");
  });

  it("switches to a slider or editable choice as the source and cursor change", () => {
    const editor = setup('$: color("red").alpha(▮0.5).blend("multiply")');
    const slider = host.querySelector<HTMLInputElement>(".pd-value-range")!;
    slider.value = "0.42";
    slider.dispatchEvent(new Event("input"));
    expect(editor.state.doc.toString()).toContain(".alpha(0.42)");
    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf("multiply") } });
    const choice = host.querySelector<HTMLSelectElement>(".pd-choice-menu")!;
    choice.value = "screen";
    choice.dispatchEvent(new Event("change"));
    expect(editor.state.doc.toString()).toContain('.blend("screen")');
    const input = host.querySelector<HTMLInputElement>(".pd-choice-tools input")!;
    input.value = "screen lighter";
    input.dispatchEvent(new Event("input"));
    expect(editor.state.doc.toString()).toContain('.blend("screen lighter")');
  });
});
