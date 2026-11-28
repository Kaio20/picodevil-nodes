declare module "@strudel/mini" {
  interface Hap<T = string> {
    value: T;
    whole: { begin: number; end: number } | null;
    part: { begin: number; end: number };
  }

  interface Pattern<T = string> {
    queryArc(begin: number, end: number): Hap<T>[];
  }

  export function mini(input: string): Pattern;

  export type MiniAst =
    | { type_: "pattern"; source_: MiniAst[] }
    | { type_: "element"; source_: MiniAst }
    | { type_: "atom"; source_: string; location_: { start: { offset: number }; end: { offset: number } } };
  export function mini2ast(quotedInput: string): MiniAst;
}
