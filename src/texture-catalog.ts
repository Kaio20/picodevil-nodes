import { getAllEntries } from "./media-registry";
import { attachNodeDrag } from "./node-sidebar-drag";
import { resolveUrl } from "./server-config";
import { getTexturePacks, importTextureFolder, useCatalogTexture } from "./texture-library";
import { insertName, makeThumbCell } from "./thumbs";

export function makeTextureCatalog(onChange: () => void, showToast: (message: string) => void) {
  const controls = document.createElement("div");
  controls.className = "texture-controls";

  const source = document.createElement("select");
  source.className = "pd-input";
  source.setAttribute("aria-label", "Texture collection");
  function showOptions(selected = "") {
    source.replaceChildren(new Option("My textures", ""));
    for (const { id, label } of getTexturePacks()) source.append(new Option(label, id));
    source.value = selected;
  }
  showOptions();

  const folder = document.createElement("input");
  folder.type = "file";
  folder.setAttribute("webkitdirectory", "");
  folder.hidden = true;
  const addFolder = document.createElement("button");
  addFolder.type = "button";
  addFolder.className = "pd-btn";
  addFolder.textContent = "Add Folder";
  addFolder.addEventListener("click", () => folder.click());
  folder.addEventListener("change", async () => {
    if (!folder.files?.length) return;
    addFolder.disabled = true;
    try {
      showOptions(await importTextureFolder(folder.files));
      selectPack();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not import this folder");
    } finally {
      folder.value = "";
      addFolder.disabled = false;
    }
  });
  controls.append(source, addFolder, folder);

  const grid = document.createElement("div");
  grid.className = "thumbs-grid texture-grid";
  grid.style.display = "none";
  let activated = false;

  function selectPack() {
    const pack = getTexturePacks().find(item => item.id === source.value);
    grid.style.display = pack ? "" : "none";
    grid.replaceChildren();
    for (const texture of pack?.textures ?? []) {
      const preview = texture.thumbnail ? texture : { ...texture, thumbnail: resolveUrl(texture.url) };
      const cell = makeThumbCell(preview, () => insertName(useCatalogTexture(texture).name), { label: texture.label, lazy: true });
      attachNodeDrag(cell, { kind: "texture" }, () => ({ kind: "texture", data: { media: useCatalogTexture(texture).id } }));
      grid.append(cell);
    }
    grid.scrollTop = 0;
    onChange();
  }

  source.addEventListener("change", selectPack);
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
