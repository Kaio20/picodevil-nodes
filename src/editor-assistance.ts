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

export function quoteValue(value: string, quote: string) {
  const json = JSON.stringify(value);
  if (quote === '"') return json;
  return "'" + json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
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

type HelpSubject = Pick<ActiveArgument, "name" | "method" | "entry">;

function helpOnCall(state: EditorState, node: SyntaxNode): HelpSubject | undefined {
  const call = callName(node, state);
  if (call) return { name: call.name, method: call.method, entry: getReference(call.name, call.method) };
}

function helpOnName(state: EditorState, node: SyntaxNode): HelpSubject | undefined {
  const member = node.name === "PropertyName" && node.parent?.name === "MemberExpression" ? node.parent : undefined;
  if (node.name !== "VariableName" && !member) return;
  const name = state.sliceDoc(node.from, node.to);
  const method = !!member;
  const entry = getReference(name, method);
  const callee = member ?? node;
  const parent = callee.parent;
  if (entry || parent?.name === "CallExpression" && parent.firstChild?.to === callee.to) {
    return { name, method, entry };
  }
}

/** The code under the caret drives the help. A wider selection can also contain a callable or signal. */
export function helpAtSelection(state: EditorState): HelpSubject | ActiveArgument | undefined {
  const { from, to, head, empty } = state.selection.main;
  const tree = ensureSyntaxTree(state, to, 20) ?? syntaxTree(state);
  const line = state.doc.lineAt(head);
  const pos = line.from + state.sliceDoc(line.from, head).trimEnd().length;
  const left = tree.resolveInner(pos, -1);
  const right = tree.resolveInner(pos, 1);
  const named = helpOnName(state, left) ?? helpOnName(state, right);
  if (named) return named;

  // When the caret is just after a completed call, describe that call.
  for (let node: SyntaxNode | null = left; node?.to === pos; node = node.parent) {
    if (node.name !== "CallExpression" || node.getChild("ArgList")?.lastChild?.name !== ")") continue;
    const subject = helpOnCall(state, node);
    if (subject) return subject;
  }

  const argument = activeArgument(state, head);
  if (argument) return argument;

  const start = empty ? line.from : from;
  const end = empty ? line.to : to;
  let closest: HelpSubject | undefined;
  let distance = Infinity;
  tree.iterate({
    from: start,
    to: end,
    enter({ node }) {
      if (node.from >= end || node.to <= start) return false;
      const candidate = node.name === "CallExpression" ? helpOnCall(state, node) : helpOnName(state, node);
      const offset = Math.max(node.from - head, head - node.to, 0);
      if (candidate && offset < distance) {
        closest = candidate;
        distance = offset;
      }
    },
  });
  return closest;
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

export function videoInsertion(state: EditorState, pos: number, name: string) {
  const context = activeArgument(state, pos);
  const tree = syntaxTree(state);
  // Names with spaces or mini operators need to stay one exact registry key.
  const miniName = /^[a-zA-Z_][\w.-]*$/.test(name) && Number.isNaN(Number(name));
  const argument = miniName ? quoteValue(name, '"') : `pure(${quoteValue(name, "'")})`;
  const source = context?.entry?.name ?? context?.name.toLowerCase();
  if (context?.index === 0 && (source === "screen" || source === "s" || source === "video")) {
    if (!context.value) return { from: context.from, to: context.to, insert: argument };
    const node = tree.resolveInner(context.from + 1, -1);
    if (miniName && node.name === "String" && node.from === context.from && node.to === context.to) {
      const pattern = context.value.slice(1, -1);
      let offset = Math.max(0, Math.min(pos - context.from - 1, pattern.length));
      if (offset > 0 && !/\s/.test(pattern[offset - 1])) {
        const gap = pattern.slice(offset).search(/\s/);
        offset = gap === -1 ? pattern.length : offset + gap;
      }
      const before = offset > 0 && !/\s/.test(pattern[offset - 1]) ? " " : "";
      const after = offset < pattern.length && !/\s/.test(pattern[offset]) ? " " : "";
      const at = context.from + 1 + offset;
      return { from: at, to: at, insert: before + name + after };
    }
  }

  // A drop on a continued expression starts a layer after the statement.
  let node = tree.resolveInner(pos, -1);
  while (node.parent && node.parent.name !== "Script") node = node.parent;
  const end = node.name === "Script" ? pos : state.doc.lineAt(node.to).to;
  const at = end > state.doc.lineAt(pos).to ? end : pos;
  return referenceInsertion(state, { from: at, to: at }, { kind: "example", text: `$: s(${argument})` });
}
