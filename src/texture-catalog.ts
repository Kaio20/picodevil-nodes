import { getAllEntries } from "./media-registry";
import { attachNodeDrag } from "./node-sidebar-drag";
import { texturePacks, useBundledTexture } from "./texture-library";
import { insertName, makeThumbCell } from "./thumbs";

export function makeTextureCatalog(onChange: () => void) {
  const controls = document.createElement("div");
  controls.className = "texture-controls";

  const source = document.createElement("select");
  source.className = "pd-input";
  source.setAttribute("aria-label", "Texture collection");
  source.append(new Option("My textures", ""));
  for (const { id, label } of texturePacks) source.append(new Option(label, id));

  const variant = document.createElement("select");
  variant.className = "pd-input";
  variant.setAttribute("aria-label", "Texture variant");
  variant.hidden = true;
  controls.append(source, variant);

  const grid = document.createElement("div");
  grid.className = "thumbs-grid texture-grid";
  grid.style.display = "none";
  let activated = false;

  function selectPack() {
    const pack = texturePacks.find(item => item.id === source.value);
    variant.replaceChildren(...(pack?.variants ?? []).map(({ id, label }) => new Option(label, id)));
    variant.hidden = variant.options.length < 2;
    renderGrid();
    onChange();
  }

  function renderGrid() {
    const pack = texturePacks.find(item => item.id === source.value);
    const version = pack?.variants.find(item => item.id === variant.value);
    grid.style.display = version ? "" : "none";
    grid.replaceChildren();
    for (const texture of version?.textures ?? []) {
      const cell = makeThumbCell(texture, () => insertName(useBundledTexture(texture).name), { label: texture.label, lazy: true });
      attachNodeDrag(cell, { kind: "texture" }, () => ({ kind: "texture", data: { media: useBundledTexture(texture).id } }));
      grid.append(cell);
    }
    grid.scrollTop = 0;
  }

  source.addEventListener("change", selectPack);
  variant.addEventListener("change", renderGrid);
  return {
    controls, grid,
    browsing: () => source.value !== "",
    activate() {
      if (activated) return;
      activated = true;
      if (!source.value && getAllEntries("textures").length === 0) {
        source.value = "particle-pack";
        selectPack();
      }
    },
    showLibrary() {
      if (!source.value) return;
      source.value = "";
      selectPack();
    },
  };
}
