import { localTextureUrl, readTextureFolders, saveTextureFolder, type LocalTextureFolder } from "./local-texture-folders";
import { addMedia, getAllEntries, isTexture, type MediaEntry } from "./media-registry";
import { textureFiles } from "./texture-files";

type CatalogTexture = MediaEntry & { label: string };
type TexturePack = { id: string; label: string; textures: CatalogTexture[] };

function builtInPack(id: keyof typeof textureFiles, label: string, folder = ""): TexturePack {
  const prefix = id.replaceAll("-", "_");
  const suffix = folder ? `_${folder.replaceAll("-", "_")}` : "";
  const textures = textureFiles[id].original.map((file): CatalogTexture => {
    const url = `/textures/${id}/${folder ? `${folder}/` : ""}${file}`;
    const stem = file.slice(0, -4);
    return { id: url, url, type: "image", thumbnail: url, name: `${prefix}_${stem}${suffix}`, label: stem.replaceAll("_", " ") };
  });
  return { id, label, textures };
}

const packs = [
  builtInPack("particle-pack", "Particle Pack"),
  builtInPack("light-masks", "Light Masks", "white-on-black"),
  builtInPack("pattern-pack", "Pattern Pack"),
];
const texturesByUrl = new Map<string, CatalogTexture>();
const changes = new EventTarget();

function indexPack(pack: TexturePack) {
  for (const texture of pack.textures) texturesByUrl.set(texture.url, texture);
}
packs.forEach(indexPack);

function indexFolder(folder: LocalTextureFolder) {
  const textures = folder.files.map(({ path }): CatalogTexture => {
    const url = localTextureUrl(folder.id, path);
    const label = path.replace(/\.[^.\/]+$/, "");
    const name = `${folder.label}_${label}`.replace(/[^a-zA-Z0-9_]+/g, "_");
    return { id: url, url, type: "image", name, label };
  });
  const pack = { id: folder.id, label: folder.label, textures };
  packs.push(pack);
  indexPack(pack);
}

export async function loadTextureLibrary() {
  try {
    for (const folder of await readTextureFolders()) indexFolder(folder);
  } catch (error) {
    console.warn("Could not restore local texture folders", error);
  }
}

export async function importTextureFolder(files: FileList): Promise<string> {
  const images = Array.from(files)
    .filter(file => file.type.startsWith("image/") || /\.(png|apng|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(file.name))
    .map(file => ({ path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name, file }));
  if (images.length === 0) throw new Error("No images in this folder");
  images.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

  const name = files[0]?.webkitRelativePath.split("/")[0] || "Local textures";
  const usedLabels = new Set(["My textures", ...packs.map(pack => pack.label)]);
  let label = name;
  for (let suffix = 2; usedLabels.has(label); suffix++) label = `${name} (${suffix})`;

  const folder: LocalTextureFolder = { id: crypto.randomUUID(), label, addedAt: Date.now(), files: [] };
  for (const { path, file } of images) {
    // Snapshot the bytes so the imported image survives changes to the original file.
    const data = await file.arrayBuffer();
    folder.files.push({ path, file: new Blob([data], { type: file.type }) });
  }
  await saveTextureFolder(folder);
  indexFolder(folder);
  changes.dispatchEvent(new Event("change"));
  return folder.id;
}

export function onTextureLibraryChange(listener: () => void) {
  changes.addEventListener("change", listener);
}

export function getTexturePacks(): readonly TexturePack[] {
  return packs;
}

export function catalogTexture(url: string) {
  return texturesByUrl.get(url);
}

export function useCatalogTexture(texture: CatalogTexture): MediaEntry {
  const existing = getAllEntries("textures").find(entry => entry.url === texture.url && isTexture(entry));
  return existing ?? addMedia(texture.url, texture.name, "image", "textures", texture.thumbnail);
}
