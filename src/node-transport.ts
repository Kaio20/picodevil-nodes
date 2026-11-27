import { Pattern, signal } from "@strudel/core";
import { CYCLES_PER_SECOND } from "./config";

export function wrapCycle(value: number): number {
  return ((value % 1) + 1) % 1;
}

interface MotionSegment { cycle: number; source: number; position: number; factor: number }

/** The transport owns updates. Pattern queries can sample past or future cycles without advancing it. */
export class NodeTransport {
  private cycle = 0;
  private cps = CYCLES_PER_SECOND;
  private seconds = 0;
  private wall?: number;
  private playlists = new Map<string, { key: string; start: number }>();

  advance(cycle: number, cps: number, wall: number) {
    if (this.wall !== undefined && this.cps > 0) this.seconds += Math.max(0, wall - this.wall) / 1000;
    this.wall = wall;
    this.cycle = cycle;
    this.cps = cps;
  }

  reset(wall: number) {
    this.seconds = this.cycle = 0;
    this.wall = wall;
    this.playlists.clear();
  }

  get position() { return this.cycle; }

  playlistStart(id: string, key: string): number {
    const current = this.playlists.get(id);
    if (current?.key === key) return current.start;
    this.playlists.set(id, { key, start: this.seconds });
    return this.seconds;
  }

  secondsAt(cycle: number): number {
    return this.cps > 0 ? this.seconds + (cycle - this.cycle) / this.cps : this.seconds;
  }

  cycleAt(seconds: number): number {
    return this.cycle + (seconds - this.seconds) * (this.cps || CYCLES_PER_SECOND);
  }
}

function sample(pattern: Pattern, cycle: number): number | undefined {
  const value = Number(pattern.queryArc(cycle, cycle)[0]?.value);
  return Number.isFinite(value) ? value : undefined;
}

class Motion {
  readonly pattern: Pattern;
  private segments: MotionSegment[];

  constructor(private source: Pattern, private factor: number | Pattern, readonly editable?: string, previous?: Motion, cycle = 0) {
    const rate = typeof factor === "number" ? factor : 0;
    const sourcePosition = sample(source, cycle) ?? 0;
    this.segments = previous
      ? [{ cycle, source: sourcePosition, position: previous.positionAt(cycle), factor: rate }]
      : [{ cycle: 0, source: 0, position: 0, factor: rate }];
    this.pattern = signal((time: number) => this.positionAt(Number(time)));
  }

  private positionAt(cycle: number) {
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.segments[mid].cycle <= cycle) low = mid;
      else high = mid - 1;
    }
    const anchor = this.segments[low];
    const value = sample(this.source, cycle) ?? anchor.source;
    return anchor.position + (value - anchor.source) * anchor.factor;
  }

  private anchor(cycle: number, factor: number) {
    const last = this.segments.at(-1)!;
    if (last.factor === factor) return;
    const source = sample(this.source, cycle) ?? last.source;
    const next = { cycle, source, position: this.positionAt(cycle), factor };
    if (last.cycle === cycle) this.segments[this.segments.length - 1] = next;
    else this.segments.push(next);
    // The renderer also samples nearby history for offsets and prewarming.
    if (this.segments.length > 4096) this.segments.splice(0, 1024);
  }

  advance(cycle: number) {
    if (typeof this.factor === "number") return;
    const factor = sample(this.factor, cycle);
    if (factor !== undefined) this.anchor(cycle, factor);
  }

  setFactor(cycle: number, factor: number) {
    this.anchor(cycle, factor);
    this.factor = factor;
  }
}

export class NodeMotions {
  readonly time = signal((cycle: number) => Number(cycle));
  private tracks = new Map<string, Motion>();
  private signals = new WeakSet<Pattern>([this.time]);

  constructor(private previous?: NodeMotions, private cycle = 0) {}

  isTime(value: unknown): value is Pattern {
    return value instanceof Pattern && this.signals.has(value);
  }

  multiply(key: string, source: Pattern, factor: Pattern | number, editable?: string): Pattern {
    const motion = new Motion(source, factor, editable, this.previous?.tracks.get(key), this.cycle);
    this.tracks.set(key, motion);
    this.signals.add(motion.pattern);
    return motion.pattern;
  }

  finish(): void { this.previous = undefined; }

  advance(cycle: number): void {
    for (const track of this.tracks.values()) track.advance(cycle);
  }

  setFactor(nodeId: string, input: string, cycle: number, value: number): boolean {
    let changed = false;
    for (const track of this.tracks.values()) {
      if (track.editable !== `${nodeId}:${input}`) continue;
      track.setFactor(cycle, value);
      changed = true;
    }
    return changed;
  }
}
