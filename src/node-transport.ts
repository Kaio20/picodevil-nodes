import { Pattern, signal } from "@strudel/core";
import { CYCLES_PER_SECOND } from "./config";
import { DEFAULT_TIME_RATE, DEFAULT_TIME_UPDATES } from "./node-graph";

export function wrapCycle(value: number): number {
  return ((value % 1) + 1) % 1;
}

interface MotionSegment { cycle: number; source: number; position: number; factor: number }

/** The transport owns updates. Pattern queries can sample past or future cycles without advancing it. */
export class NodeTransport {
  private cycle = 0;
  private seconds = 0;
  private wall?: number;
  private playlists = new Map<string, { key: string; start: number }>();

  constructor(private cps = CYCLES_PER_SECOND) {}

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

interface TimeSegment { wall: number; elapsed: number; rate: number; updates: number }
const ELAPSED_PERIOD = 32768;

/** Time nodes share tick boundaries and rate, and each has its own zero point. */
export class NodeTime {
  readonly rateSignal = signal(() => this.currentRate);
  private segments: TimeSegment[];
  private starts = new Map<string, number>();
  private wall: number;
  private playbackCycle = 0;
  private playbackCps = CYCLES_PER_SECOND;
  private phaseRevision = 0;

  constructor(rate = DEFAULT_TIME_RATE, now = 0, updates = DEFAULT_TIME_UPDATES) {
    this.segments = [{ wall: now, elapsed: 0, rate, updates }];
    this.wall = now;
  }

  get position() { return this.elapsedAt(this.wall); }
  get currentRate() { return this.segments.at(-1)!.rate; }
  get currentUpdates() { return this.segments.at(-1)!.updates; }
  get revision() { return this.phaseRevision; }

  configure(rate: number, updates: number, now: number, restart = false) {
    if (restart) {
      this.segments = [{ wall: now, elapsed: 0, rate, updates }];
      this.starts.clear();
      this.phaseRevision++;
    } else if (rate !== this.currentRate || updates !== this.currentUpdates) {
      const current = this.segments.at(-1)!;
      const wall = updates === current.updates ? current.wall + this.ticksAt(current, now) / updates * 1000 : now;
      const next = { wall, elapsed: this.elapsedAt(now), rate, updates };
      if (wall === current.wall) this.segments[this.segments.length - 1] = next;
      else this.segments.push(next);
    }
  }

  trackNodes(ids: Set<string>, now: number, source?: NodeTime) {
    const start = this.elapsedAt(now);
    for (const id of ids) {
      if (this.starts.has(id)) continue;
      const elapsed = source?.starts.has(id) ? source.localElapsedAt(id, now) : 0;
      this.starts.set(id, start - elapsed);
    }
    for (const id of this.starts.keys()) if (!ids.has(id)) this.starts.delete(id);
  }

  alignNodes(ids: Set<string>, source: NodeTime, now: number) {
    const elapsed = this.elapsedAt(now);
    let changed = false;
    for (const id of ids) {
      if (!this.starts.has(id) || !source.starts.has(id)) continue;
      const start = elapsed - source.localElapsedAt(id, now);
      if (Math.abs(start - this.starts.get(id)!) < 1e-9) continue;
      this.starts.set(id, start);
      changed = true;
    }
    if (changed) this.phaseRevision++;
  }

  elapsedSignal(id: string): Pattern {
    return signal((cycle: number) => this.unwrappedElapsed(id, Number(cycle)) % ELAPSED_PERIOD);
  }

  unwrappedElapsed(id: string, cycle: number): number {
    const offset = this.playbackCps > 0 ? (cycle - this.playbackCycle) / this.playbackCps : 0;
    return this.localElapsedAt(id, this.wall + offset * 1000);
  }

  private localElapsedAt(id: string, wall: number) {
    return Math.max(0, this.elapsedAt(wall) - (this.starts.get(id) ?? 0));
  }

  private elapsedAt(wall: number) {
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.segments[mid].wall <= wall) low = mid;
      else high = mid - 1;
    }
    const segment = this.segments[low];
    return segment.elapsed + this.ticksAt(segment, wall) / segment.updates * segment.rate;
  }

  private ticksAt(segment: TimeSegment, wall: number) {
    return Math.floor(Math.max(0, wall - segment.wall) * segment.updates / 1000 + 1e-8);
  }

  advance(playbackCycle: number, playbackCps: number, now: number) {
    this.playbackCycle = playbackCycle;
    this.playbackCps = playbackCps;
    this.wall = now;
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
  private tracks = new Map<string, Motion>();
  private signals = new WeakSet<Pattern>();

  constructor(readonly time = new NodeTime(), private previous?: NodeMotions, private cycle = 0) {}

  elapsed(id: string): Pattern {
    const pattern = this.time.elapsedSignal(id);
    this.signals.add(pattern);
    return pattern;
  }

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
