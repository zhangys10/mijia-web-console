import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { SpatialLayoutStore } from "./spatial-layout-store.ts";

const validKey = /^homes\/[a-f0-9]{64}\/(?:current\.json|revisions\/layout_[a-f0-9-]{16,64}\.json|uploads\/[a-f0-9-]{36}\.(?:png|jpg|webp|glb))$/;

export function createLocalSpatialLayoutStore(directory: string): SpatialLayoutStore {
  const root = resolve(directory);
  const fileFor = (key: string) => {
    if (!validKey.test(key)) throw new Error("invalid spatial layout key");
    const file = resolve(root, key);
    if (!file.startsWith(`${root}/`)) throw new Error("invalid spatial layout key");
    return file;
  };
  return {
    async get(key, options) {
      try {
        const value = await readFile(fileFor(key));
        if (options?.type === "json") return JSON.parse(value.toString("utf8")) as unknown;
        if (options?.type === "arrayBuffer") return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        return value.toString("utf8");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async set(key, value) {
      const file = fileFor(key); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const buffer = typeof value === "string" ? Buffer.from(value) : value instanceof Blob ? Buffer.from(await value.arrayBuffer()) : Buffer.from(value);
      await writeFile(file, buffer, { mode: 0o600 });
    },
    async setJSON(key, value, options) {
      const file = fileFor(key); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: options?.onlyIfNew ? "wx" : "w" });
    },
    async delete(key) { await rm(fileFor(key), { force: true }); },
    async list(options) {
      const prefix = options?.prefix ?? "";
      const start = resolve(root, prefix);
      const files: string[] = [];
      async function walk(directory: string) {
        try { for (const entry of await readdir(directory, { withFileTypes: true })) { if (entry.isDirectory()) await walk(resolve(directory, entry.name)); else files.push(relative(root, resolve(directory, entry.name))); } }
        catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
      }
      await walk(start); return { blobs: files.filter(key => key.startsWith(prefix)).map(key => ({ key })) };
    },
  };
}

export function localSpatialLayoutStore(directory?: string) { return createLocalSpatialLayoutStore(directory?.trim() || ".local/spatial-layout"); }
