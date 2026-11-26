import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { getReference, type CodeFragment, type ReferenceEntry } from "./editor-catalog";

export interface ActiveArgument {
  name: string;
  method: boolean;
  index: number;
  from: number;
  to: number;
  callEnd: number;
  value: string;
  entry?: ReferenceEntry;
}

export function callName(call: SyntaxNode, state: EditorState) {
  const callee = call.firstChild;
  const method = callee?.name === "MemberExpression";
  const name = method ? callee.lastChild : callee;
  if (name?.name !== "PropertyName" && name?.name !== "VariableName") return;
  return { name: state.doc.sliceString(name.from, name.to), method, from: name.from, to: name.to };
}

export function activeArgument(state: EditorState, pos = state.selection.main.head): ActiveArgument | undefined {
  const tree = ensureSyntaxTree(state, pos, 20) ?? syntaxTree(state);
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  // In an unfinished call the parser can end the argument list before trailing spaces.
  const trimmedPos = line.from + before.trimEnd().length;
  for (let node: SyntaxNode | null = tree.resolveInner(trimmedPos, -1); node; node = node.parent) {
    if (node.name !== "ArgList" || node.parent?.name !== "CallExpression") continue;
    const open = node.firstChild;
    const close = node.lastChild?.name === ")" ? node.lastChild : undefined;
    if (!open || pos < open.to || close && pos > close.from) continue;
    const callee = callName(node.parent, state);
    if (!callee) continue;

    let index = 0;
    let from = open.to;
    let end = close?.from ?? Math.max(node.to, pos);
    for (const comma of node.getChildren(",")) {
      if (comma.to > pos) { end = comma.from; break; }
      index++;
      from = comma.to;
    }
    const tokens = [];
    for (let child = open.nextSibling; child && child.from < end; child = child.nextSibling) {
      if (child.from >= from && !child.type.isError && !["LineComment", "BlockComment", ","].includes(child.name)) tokens.push(child);
    }
    if (tokens.length) {
      from = tokens[0].from;
      end = tokens[tokens.length - 1].to;
    }
    const raw = state.doc.sliceString(from, end);
    const value = raw.trim();
    from += raw.length - raw.trimStart().length;
    return { ...callee, index, from, to: from + value.length, value, callEnd: node.parent.to,
      entry: getReference(callee.name, callee.method) };
  }
}

export function referenceInsertion(state: EditorState, range: { from: number; to: number }, fragment: CodeFragment) {
  let { from, to } = range;
  const line = state.doc.lineAt(from);
  const before = state.doc.sliceString(line.from, from);
  const after = state.doc.sliceString(to, Math.max(to, line.to));
  const context = activeArgument(state, from);
  let insert = fragment.text;
  if (fragment.kind === "method" && from === to && context) {
    from = to = context.callEnd;
  } else if (fragment.kind === "method" && !before.trim() && !after.trim()) {
    const previous = line.number > 1 ? state.doc.line(line.number - 1).text.trimEnd() : "";
    if (!/[)\]]$/.test(previous)) insert = '$: color("#5ba8ff")' + insert;
  } else if (fragment.kind === "expression" && fragment.layer && !context) {
    if (!before.trim() && !after.trim()) insert = "$: " + insert;
    else if (from === to && /[)\]];?\s*$/.test(before) && !after.trim()) insert = "\n$: " + insert;
  } else if (fragment.kind === "example" && from === to) {
    if (before.trim()) {
      from = to = line.to;
      insert = "\n" + insert;
    } else if (after.trim()) {
      insert += "\n";
    }
  }
  if (fragment.kind === "method" && from > 0 && state.doc.sliceString(from - 1, from) === "." && insert.startsWith(".")) {
    insert = insert.slice(1);
  }
  return { from, to, insert };
}
