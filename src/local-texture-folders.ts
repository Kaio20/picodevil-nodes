const storeName = "folders";

export interface LocalTextureFolder {
  id: string;
  label: string;
  addedAt: number;
  files: { path: string; file: Blob }[];
}

const images = new Map<string, { file: Blob; objectUrl?: string }>();

export function localTextureUrl(folderId: string, path: string) {
  return `local-texture:${folderId}/${encodeURIComponent(path)}`;
}

export function resolveLocalTexture(url: string): string {
  const image = images.get(url);
  if (!image) return url;
  return image.objectUrl ??= URL.createObjectURL(image.file);
}

async function accessFolders<T>(mode: IDBTransactionMode, query: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("picodevil-texture-folders", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = query(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function indexFolder(folder: LocalTextureFolder) {
  for (const { path, file } of folder.files) images.set(localTextureUrl(folder.id, path), { file });
}

export async function readTextureFolders() {
  const folders = await accessFolders<LocalTextureFolder[]>("readonly", store => store.getAll());
  folders.sort((a, b) => a.addedAt - b.addedAt);
  for (const folder of folders) indexFolder(folder);
  return folders;
}

export async function saveTextureFolder(folder: LocalTextureFolder) {
  await accessFolders("readwrite", store => store.add(folder));
  indexFolder(folder);
}
