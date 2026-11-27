import { Hap, Pattern, TimeSpan, fastcat, pure, reify, silence, slowcat } from "@strudel/core";
import { resolveMedia, resolveMediaId } from "./media-registry";
import { getVideoBase, resolveUrl } from "./server-config";
import type { NodeTransport } from "./node-transport";

type Duration = number | "loading" | "unavailable";
type Clip = { src: string; url: string; duration?: number; unavailable?: boolean };
const probes = new Map<string, Duration>();
const listeners = new Set<() => void>();

export function onVideoMetadata(listener: () => void) { listeners.add(listener); }

function resolveClip(value: unknown): Clip | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  const name = value.trim();
  const entry = resolveMediaId(name) ?? resolveMedia(name);
  if (entry) return { src: entry.name, url: resolveUrl(entry.url), duration: entry.duration, unavailable: entry.type !== "video" || entry.unavailable };
  const url = /^(https?:|blob:|data:|\/)/i.test(name) ? resolveUrl(name) : getVideoBase() + name;
  return { src: url, url };
}

function durationFor(clip: Clip): Duration {
  if (clip.unavailable) return "unavailable";
  if (clip.duration && Number.isFinite(clip.duration)) return clip.duration;
  const known = probes.get(clip.url);
  if (known !== undefined) return known;
  if (!clip.url || typeof document === "undefined") return "unavailable";
  probes.set(clip.url, "loading");
  const video = document.createElement("video");
  video.preload = "metadata";
  function finish(result: Duration) {
    if (probes.get(clip.url) !== "loading") return;
    clearTimeout(timeout);
    video.onloadedmetadata = video.onerror = null;
    video.removeAttribute("src");
    video.load();
    probes.set(clip.url, result);
    for (const listener of listeners) listener();
  }
  video.onloadedmetadata = () => finish(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : "unavailable");
  video.onerror = () => finish("unavailable");
  const timeout = setTimeout(() => finish("unavailable"), 15_000);
  video.src = clip.url;
  return "loading";
}

export function videoDuration(value: unknown): Duration | undefined {
  const clip = resolveClip(value);
  return clip && durationFor(clip);
}

const videoEvent = (clip: Clip) => ({ _type: "video", src: clip.src, begin: 0, end: 1 });

/** Return the clip and its offset on a repeating wall-time playlist. */
export function playlistClipAt(durations: readonly number[], seconds: number) {
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  const repetition = Math.floor(seconds / total);
  let start = repetition * total;
  for (const [index, duration] of durations.entries()) {
    const end = start + duration;
    if (seconds < end) return { index, start, end };
    start = end;
  }
  return { index: 0, start, end: start + durations[0] };
}

export function nodeVideoPattern(id: string, inputs: readonly (string | Pattern)[], mode: string, transport: NodeTransport): Pattern {
  const rows = inputs.filter(value => typeof value !== "string" || value.trim());
  if (!rows.length) return silence;
  if (mode !== "clipEnd") {
    const clips = rows.map(row => (typeof row === "string" ? pure(row) : reify(row)).bind((value: unknown) => {
      const clip = resolveClip(value);
      return clip && !clip.unavailable ? pure(videoEvent(clip)) : silence;
    }));
    return mode === "clipPerCycle" ? slowcat(...clips) : fastcat(...clips);
  }

  return new Pattern((state: any) => {
    const begin = Number(state.span.begin);
    const end = Number(state.span.end);
    const candidates = rows.map(row => {
      const cycle = transport.position;
      const value = typeof row === "string" ? row : row.queryArc(cycle, cycle)[0]?.value;
      const clip = resolveClip(value);
      return clip && { clip, duration: durationFor(clip) };
    });
    // Wait for the full list so loading a later duration cannot shift an active clip.
    if (candidates.some(entry => entry?.duration === "loading")) return [];
    const clips = candidates.flatMap(entry => entry && typeof entry.duration === "number"
      ? [{ clip: entry.clip, duration: entry.duration }] : []);
    if (!clips.length) return [];
    const key = JSON.stringify(clips.map(({ clip, duration }) => [clip.url, duration]));
    const startAt = transport.playlistStart(id, key);
    const durations = clips.map(clip => clip.duration);
    const seconds = transport.secondsAt(begin) - startAt;
    const finish = transport.secondsAt(end) - startAt;
    const haps: Hap[] = [];
    let cursor = seconds;
    do {
      const { index, start, end: clipEnd } = playlistClipAt(durations, cursor);
      const event = {
        ...videoEvent(clips[index].clip),
        _playlistStart: startAt + start,
        _playlistElapsed: Math.max(0, cursor - start),
      };
      const whole = new TimeSpan(transport.cycleAt(startAt + start), transport.cycleAt(startAt + clipEnd));
      const part = begin === end ? state.span : state.span.intersection(whole);
      if (part) haps.push(new Hap(whole, part, event));
      if (clipEnd <= cursor) break;
      cursor = clipEnd;
    } while (cursor < finish && haps.length < 256);
    return haps;
  });
}
