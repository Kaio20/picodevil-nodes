import { addMedia, getAllEntries, isTexture, type MediaEntry } from "./media-registry";
import { textureFiles } from "./texture-files";

type BundledTexture = MediaEntry & { label: string };
type Variant = [id: string, label: string, files: readonly string[]];

function pack(id: keyof typeof textureFiles, label: string, variants: Variant[]) {
  const prefix = id.replaceAll("-", "_");
  return {
    id, label,
    variants: variants.map(([version, label, files]) => {
      const folder = version === "original" ? "" : `${version}/`;
      const suffix = folder ? `_${version.replaceAll("-", "_")}` : "";
      const textures = files.map((file): BundledTexture => {
        const url = `/textures/${id}/${folder}${file}`;
        const stem = file.slice(0, -4);
        return {
          id: url, url, type: "image", thumbnail: url,
          name: `${prefix}_${stem}${suffix}`,
          label: stem.replaceAll("_", " "),
        };
      });
      return { id: version, label, textures };
    }),
  };
}

const masks = textureFiles["light-masks"].original;
export const texturePacks = [
  pack("particle-pack", "Kenney · Particle Pack", [
    ["original", "Standard", textureFiles["particle-pack"].original],
    ["rotated", "Rotated", textureFiles["particle-pack"].rotated],
  ]),
  pack("light-masks", "Kenney · Light Masks", [
    ["original", "Transparent", masks],
    ["white-on-black", "White on black", masks],
    ["black-on-white", "Black on white", masks],
  ]),
  pack("pattern-pack", "Kenney · Pattern Pack", [
    ["original", "Standard", textureFiles["pattern-pack"].original],
  ]),
];

const bundledTextures = new Map(
  texturePacks.flatMap(pack => pack.variants.flatMap(variant => variant.textures.map(texture => [texture.url, texture] as const))),
);

export function bundledTexture(url: string) {
  return bundledTextures.get(url);
}

export function useBundledTexture(texture: BundledTexture): MediaEntry {
  const existing = getAllEntries("textures").find(entry => entry.url === texture.url && isTexture(entry));
  return existing ?? addMedia(texture.url, texture.name, "image", "textures", texture.thumbnail);
}
