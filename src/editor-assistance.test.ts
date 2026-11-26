import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { EditorState } from "@codemirror/state";
import { closeBrackets } from "@codemirror/autocomplete";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { EditorView } from "@codemirror/view";
import { activeArgument, referenceInsertion, videoInsertion } from "./editor-assistance";
import { getReference } from "./editor-catalog";
import { color } from "./color-pattern";
import { editorCompletion } from "./editor-completion";
import { argumentBar } from "./editor-argument-bar";
import { hexColorWidgets } from "./editor-hex-colors";
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

  it("drops a video as a new layer, or adds a step without splitting an existing step", () => {
    function drop(source: string, name = "ducks") {
      const state = atCaret(source);
      return state.update({ changes: videoInsertion(state, state.selection.main.head, name) }).state.doc.toString();
    }
    expect(drop("▮")).toBe('$: s("ducks")');
    expect(drop('$: s("re▮d*2 blue")')).toBe('$: s("red*2 ducks blue")');
    expect(drop('$: video(▮)')).toBe('$: video("ducks")');
    expect(drop('$: stack(\n  color("re▮d"),\n  color("blue"),\n)'))
      .toBe('$: stack(\n  color("red"),\n  color("blue"),\n)\n$: s("ducks")');
    expect(drop("▮", "my clip's name")).toBe("$: s(pure('my clip\\'s name'))");
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
        extensions: [javascriptLanguage, closeBrackets(), editorCompletion, argumentBar(host), hexColorWidgets],
      }),
    });
    return view;
  }
  afterEach(() => {
    view.destroy();
    host.replaceChildren();
    host.remove();
  });

  it("shows function help on a method name, the completed call and its argument", () => {
    const code = '$: color("red").opacity(0.5);';
    const name = code.indexOf("opacity");
    const value = code.indexOf("0.5");
    const editor = setup(code.slice(0, name + 2) + "▮" + code.slice(name + 2));
    const functionName = () => host.querySelector(".pd-function-name")?.textContent;
    const parameter = () => host.querySelector(".pd-current-parameter")?.textContent;
    const explanation = () => host.querySelector(".pd-argument-description")?.textContent;
    expect(functionName()).toBe(".opacity");
    expect(explanation()).toContain("Sets the transparency");
    expect(parameter()).toBeUndefined();

    editor.dispatch({ selection: { anchor: name, head: name + "opacity".length } });
    expect(functionName()).toBe(".opacity");
    expect(parameter()).toBeUndefined();
    editor.dispatch({ selection: { anchor: code.length } });
    expect(functionName()).toBe(".opacity");
    expect(parameter()).toBeUndefined();
    editor.dispatch({ selection: { anchor: value + 1 } });
    expect(functionName()).toBe(".opacity");
    expect(parameter()).toBe("value");
  });

  it("finds help for a nested call, a selected signal and a larger code selection", () => {
    const code = '$: color("red").alpha(sine.range(0, 1));\nconst label = "alpha";';
    const editor = setup("▮" + code);
    const signature = () => host.querySelector(".pd-signature")?.textContent;
    const signal = code.indexOf("sine");
    const range = code.indexOf("range");
    editor.dispatch({ selection: { anchor: range, head: range + 5 } });
    expect(signature()).toBe(".range(min, max)");
    editor.dispatch({ selection: { anchor: signal, head: signal + 4 } });
    expect(signature()).toBe("sine");
    editor.dispatch({ selection: { anchor: code.indexOf("\n"), head: 0 } });
    expect(signature()).toBe(".alpha(value)");
    editor.dispatch({ selection: { anchor: code.lastIndexOf("alpha") + 1 } });
    expect(signature()).toBe("Function help");
  });

  it("previews a float default and lets typing replace it after Tab completion", async () => {
    const editor = setup('$: color("red").▮');
    editor.focus();
    await userEvent.keyboard("alp");
    await expect.poll(() => host.querySelector(".pd-ghost-text")?.textContent).toBe("ha(0.0)");
    expect(editor.state.doc.toString()).toBe('$: color("red").alp');
    await userEvent.keyboard("{Tab}");
    expect(editor.state.doc.toString()).toBe('$: color("red").alpha(0.0)');
    expect(host.querySelector(".pd-current-parameter")?.textContent).toBe("value");
    await expect.element(page.getByRole("spinbutton", { name: "alpha value" })).toHaveValue(0);
    await userEvent.keyboard(".25");
    expect(editor.state.doc.toString()).toBe('$: color("red").alpha(0.25)');
  });

  it("initializes float arguments when typing a call and accepts separators", async () => {
    const editor = setup('$: color("red").crop▮');
    editor.focus();
    await userEvent.keyboard("(");
    expect(editor.state.doc.toString()).toBe('$: color("red").crop(0.0)');
    await userEvent.keyboard(",");
    expect(editor.state.doc.toString()).toBe('$: color("red").crop(0.0,0.0)');
    await userEvent.keyboard(")");
    expect(editor.state.doc.toString()).toBe('$: color("red").crop(0.0,0.0)');
    expect(editor.state.selection.main.head).toBe(editor.state.doc.length);
  });

  it("starts a new scale input at 0.0 and keeps the leading zero in decimals", async () => {
    const editor = setup('$: color("red").scale▮');
    editor.focus();
    await userEvent.keyboard("(");
    const scale = page.getByRole("spinbutton", { name: "scale value", exact: true });
    expect((scale.element() as HTMLInputElement).value).toBe("0.0");
    await scale.click();
    await userEvent.keyboard(".60");
    expect(editor.state.doc.toString()).toBe('$: color("red").scale(0.60)');
    await userEvent.keyboard("{Tab}");
    expect((scale.element() as HTMLInputElement).value).toBe("0.60");
  });

  it("switches between a slider and an editable dropdown on the active line", async () => {
    const editor = setup('$: color("red").alpha(▮0.5).blend("multiply")');
    const slider = editor.contentDOM.querySelector<HTMLInputElement>(".cm-line .pd-value-range")!;
    const number = page.getByRole("spinbutton", { name: "alpha value", exact: true });
    expect(slider).not.toBeNull();
    expect(host.querySelector(".pd-argument-bar .pd-number-tools")).toBeNull();
    expect(host.querySelector(".pd-argument-bar .pd-current-parameter")?.textContent).toBe("value");
    expect(editor.contentDOM.textContent).not.toContain("0.5");
    await number.fill("0.40");
    expect(editor.state.doc.toString()).toContain(".alpha(0.40)");
    slider.focus();
    slider.value = "0.42";
    slider.dispatchEvent(new Event("input"));
    expect(editor.state.doc.toString()).toContain(".alpha(0.42)");
    expect(editor.contentDOM.querySelector(".pd-value-range")).toBe(slider);
    expect(document.activeElement).toBe(slider);
    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf("multiply") } });
    expect(editor.contentDOM.textContent).toContain(".alpha(0.42)");
    expect(editor.contentDOM.textContent).not.toContain("multiply");
    expect(editor.contentDOM.querySelector(".pd-number-tools")).toBeNull();
    expect(editor.contentDOM.querySelector(".cm-line [role=combobox]")).not.toBeNull();
    expect(host.querySelector(".pd-argument-bar [role=combobox]")).toBeNull();
    const input = page.getByRole("combobox", { name: "blend value" });
    await input.click();
    const common = page.getByRole("group", { name: "Common" });
    await expect.element(common.getByRole("option", { name: "screen", exact: true })).toBeVisible();
    await common.getByRole("option", { name: "screen", exact: true }).click();
    expect(editor.state.doc.toString()).toContain('.blend("screen")');
    await input.fill("screen lighter");
    expect(editor.state.doc.toString()).toContain('.blend("screen lighter")');
  });

  it("offers choices for an empty argument and supports filtering and keyboard selection", async () => {
    const editor = setup('$: color("red").blend(▮)');
    const input = page.getByRole("combobox", { name: "blend value" });
    await input.click();
    await expect.element(page.getByRole("option", { name: "source-over", exact: true })).toBeVisible();
    await input.fill("mul");
    await expect.element(page.getByRole("option", { name: "screen", exact: true })).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(editor.state.doc.toString()).toBe('$: color("red").blend("multiply")');
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  });

  it("offers free text inline and leaves code expressions editable in the source", async () => {
    const editor = setup("$: text(▮).blend(mode)");
    const input = page.getByRole("textbox", { name: "text pat" });
    expect(editor.contentDOM.querySelector(".cm-line input")).not.toBeNull();
    await input.fill("hello world");
    expect(editor.state.doc.toString()).toBe("$: text('hello world').blend(mode)");
    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf("mode") } });
    expect(editor.contentDOM.querySelector(".pd-inline-control")).toBeNull();
  });

  it("opens the fork picker beside a hex pattern step and copies only the source", async () => {
    const code = '$: color("<#123 #265c4280 #3e8948>")\n// "#789abc"';
    const editor = setup("▮" + code);
    const swatches = () => editor.contentDOM.querySelectorAll(".pd-hex-color");
    expect(swatches()).toHaveLength(3);
    expect(Array.from(swatches(), swatch => editor.posAtDOM(swatch))).toEqual(
      ["#123", "#265c4280", "#3e8948"].map(value => code.indexOf(value) + value.length),
    );
    await page.getByRole("button", { name: "Edit color #265c4280" }).click();
    const picker = page.getByRole("dialog", { name: /Edit color .* picker/ });
    const hex = picker.getByRole("textbox", { name: "Hex" });
    await expect.element(picker).toBeVisible();
    await hex.fill("#3e8948");
    await userEvent.keyboard("{Enter}");
    expect(editor.state.doc.toString()).toBe(code.replace("#265c4280", "#3e894880"));
    await expect.element(picker).toBeVisible();
    await hex.fill("#3e8948ff");
    await userEvent.keyboard("{Enter}");
    expect(editor.state.doc.toString()).toBe(code.replace("#265c4280", "#3e8948"));
    await expect.element(picker).toBeVisible();

    await userEvent.keyboard("{Escape}");
    editor.focus();
    editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } });
    const clipboard = new DataTransfer();
    editor.contentDOM.dispatchEvent(new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    expect(clipboard.getData("text/plain")).toBe(editor.state.doc.toString());
    expect(clipboard.getData("text/html")).toBe("");
  });

  it("shows a swatch while typing a hex color and reopens the picker after clicking away", async () => {
    const editor = setup('$: color("▮")');
    const outside = document.createElement("button");
    outside.textContent = "Outside the picker";
    host.append(outside);

    editor.focus();
    await userEvent.keyboard("#");
    const empty = page.getByRole("button", { name: "Edit color #", exact: true });
    await expect.element(empty).toBeVisible();
    expect(editor.state.doc.toString()).toBe('$: color("#")');
    await userEvent.keyboard("12");

    const partial = page.getByRole("button", { name: "Edit color #12", exact: true });
    await partial.click();
    const picker = page.getByRole("dialog", { name: /Edit color .* picker/ });
    const hex = picker.getByRole("textbox", { name: "Hex" });
    await expect.element(hex).toHaveValue("#12");
    await hex.fill("#123456");
    await page.getByRole("button", { name: "Outside the picker" }).click();
    await expect.element(picker).not.toBeInTheDocument();
    expect(editor.state.doc.toString()).toBe('$: color("#123456")');

    await page.getByRole("button", { name: "Edit color #123456", exact: true }).click();
    await expect.element(hex).toHaveValue("#123456");
    await hex.fill("#654321");
    await userEvent.keyboard("{Enter}");
    expect(editor.state.doc.toString()).toBe('$: color("#654321")');
  });

  it("leaves the swatch reachable while typing in the inline pattern input", async () => {
    const editor = setup('$: color("▮red blue")');
    const pattern = page.getByRole("textbox", { name: "Pattern steps" });
    await pattern.fill("<#");
    await expect.element(page.getByRole("button", { name: "Edit color #", exact: true })).toBeVisible();
    await userEvent.keyboard("abcd");
    expect(editor.state.doc.toString()).toBe('$: color("<#abcd")');
    await expect.element(page.getByRole("button", { name: "Edit color #abcd", exact: true })).toBeVisible();
  });

  it("offers a hex picker in an empty editor without changing the typed hash", async () => {
    const editor = setup("▮");
    editor.focus();
    await userEvent.keyboard("#");
    const swatch = page.getByRole("button", { name: "Edit color #", exact: true });
    await swatch.click();
    const picker = page.getByRole("dialog", { name: "Edit color # picker" });
    await expect.element(picker.getByRole("textbox", { name: "Hex" })).toHaveValue("#");
    await userEvent.keyboard("{Escape}");
    expect(editor.state.doc.toString()).toBe("#");
    await expect.element(swatch).toBeVisible();
  });

  it("writes a quoted color only when a value is chosen for an unquoted token", async () => {
    const editor = setup('const shade=▮;');
    editor.focus();
    await userEvent.keyboard("#123");
    expect(editor.state.doc.toString()).toBe("const shade=#123;");
    await page.getByRole("button", { name: "Edit color #123", exact: true }).click();
    const picker = page.getByRole("dialog", { name: /Edit color .* picker/ });
    const hex = picker.getByRole("textbox", { name: "Hex" });
    await hex.fill("#3e8948");
    await userEvent.keyboard("{Enter}");
    expect(editor.state.doc.toString()).toBe('const shade="#3e8948";');
    await hex.fill("#265c42");
    await userEvent.keyboard("{Enter}");
    expect(editor.state.doc.toString()).toBe('const shade="#265c42";');
  });

  it("skips hex-like identifiers, URL fragments, and tokens longer than eight digits", () => {
    const editor = setup(`▮class Fields { #abcdef; }
image("tiles.png#abcdef")
color("#12345 #123456789")
const shades = \`[#abc4,#abcdef]\`;`);
    expect([...editor.contentDOM.querySelectorAll(".pd-hex-color > button")].map(button => button.getAttribute("aria-label")))
      .toEqual(["Edit color #12345", "Edit color #abc4", "Edit color #abcdef"]);
  });
});
