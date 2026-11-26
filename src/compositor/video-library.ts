import { DEFAULT_MEDIA_URL, fetchDefaultMedia } from "../default-media";
import { addMedia, addOnChange, downloadYouTube, isYouTubeUrl, removeMedia } from "../media-registry";
import { getServerUrl } from "../server-config";

export interface RemoteAsset {
  id: string;
  name: string;
  url: string;
  type: "video" | "image";
  thumbnail?: string;
  example?: boolean;
}

export function mediaUrl(value: string, base?: string) {
  const input = value.trim();
  if (!input) throw new Error("Paste a video or image URL.");
  const url = new URL(input, base);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an HTTP or HTTPS media URL.");
  return url;
}

function linkedAsset(url: URL, name?: string, type?: RemoteAsset["type"]): RemoteAsset {
  const filename = url.pathname.split("/").filter(Boolean).pop() ?? url.hostname;
  const inferredType = /\.(png|jpe?g|webp|gif|avif|svg|bmp)$/i.test(filename) ? "image" : "video";
  return { id: `url:${url.href}`, name: name || filename.replace(/\.[^.]+$/, ""), url: url.href, type: type ?? inferredType };
}

export async function loadPicoDevilExamples() {
  const items = await fetchDefaultMedia();
  return items.flatMap(item => {
    if (item.type === "stream") return [];
    try {
      const asset = linkedAsset(mediaUrl(item.url, DEFAULT_MEDIA_URL), item.name, item.type);
      return [{ ...asset, example: true, thumbnail: item.thumbnail ? mediaUrl(item.thumbnail, DEFAULT_MEDIA_URL).href : undefined }];
    } catch { return []; }
  });
}

export async function importMediaUrl(raw: string) {
  const url = mediaUrl(raw);
  if (!isYouTubeUrl(url.href)) return linkedAsset(url);
  const server = getServerUrl();
  if (!server) throw new Error("Configure the PicoDevil server in the classic editor to import YouTube links.");
  // Use the classic editor's download and readiness protocol on this page's registry.
  const entry = addMedia(url.href);
  let unsubscribe: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      unsubscribe = addOnChange(() => {
        if (entry.downloading) return;
        if (entry.error) reject(new Error(entry.error));
        else if (entry.url !== url.href) resolve();
        else reject(new Error("The video server did not return a playable URL."));
      });
      void downloadYouTube(entry.name, server).catch(reject);
    });
    const converted = linkedAsset(mediaUrl(entry.url, server + "/"), entry.name, "video");
    return { ...converted, id: `url:${url.href}`, thumbnail: entry.thumbnail };
  } finally {
    unsubscribe?.();
    removeMedia(entry.name);
  }
}
