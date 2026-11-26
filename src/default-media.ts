import type { SourceItem } from "./media-registry";

export const DEFAULT_MEDIA_URL = "https://videoclip.picodevil.com/sources.json";

export async function fetchDefaultMedia(): Promise<SourceItem[]> {
  const response = await fetch(DEFAULT_MEDIA_URL);
  if (!response.ok) throw new Error(`PicoDevil media catalog returned ${response.status}.`);
  const items: unknown = await response.json();
  return Array.isArray(items) ? items.filter((item): item is SourceItem =>
    Boolean(item && typeof item === "object" && typeof item.url === "string")) : [];
}
