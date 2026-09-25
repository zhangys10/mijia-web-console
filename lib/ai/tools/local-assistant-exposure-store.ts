import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AssistantExposureStore } from "./assistant-exposure.ts";

const HOME_KEY = /^homes\/[a-f0-9]{64}\.json$/;
const AUDIT_KEY = /^homes\/[a-f0-9]{64}\/audit\/[0-9]+-[a-f0-9-]{36}\.json$/;
const workerMemoryStores = new Map<string, Map<string, unknown>>();

/** A local-only filesystem store for Next development routes. Production handlers use Pages Blob. */
export function createLocalAssistantExposureStore(directory: string): AssistantExposureStore {
  const root = resolve(directory);

  function fileFor(key: string) {
    if (!HOME_KEY.test(key) && !AUDIT_KEY.test(key)) throw new Error("invalid assistant exposure key");
    const file = resolve(root, key);
    if (!file.startsWith(`${root}/`)) throw new Error("invalid assistant exposure key");
    return file;
  }

  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(fileFor(key), "utf8")) as unknown;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async setJSON(key, value, options) {
      const file = fileFor(key);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const contents = `${JSON.stringify(value)}\n`;
      if (options?.onlyIfNew) {
        const handle = await open(file, "wx", 0o600);
        try { await handle.writeFile(contents, "utf8"); }
        catch (error) { await rm(file, { force: true }); throw error; }
        finally { await handle.close(); }
        return;
      }
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(contents, "utf8"); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}

export function localAssistantExposureStore(directoryValue?: string) {
  const directory = directoryValue?.trim() || ".local/assistant-exposure";
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    let entries = workerMemoryStores.get(directory);
    if (!entries) {
      entries = new Map();
      workerMemoryStores.set(directory, entries);
    }
    return {
      async get(key: string) {
        const value = entries.get(key);
        return value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown;
      },
      async setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }) {
        if (!HOME_KEY.test(key) && !AUDIT_KEY.test(key)) throw new Error("invalid assistant exposure key");
        if (options?.onlyIfNew && entries.has(key)) {
          throw Object.assign(new Error("assistant exposure record already exists"), { code: "EEXIST" });
        }
        entries.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      },
    } satisfies AssistantExposureStore;
  }
  return createLocalAssistantExposureStore(directory);
}
