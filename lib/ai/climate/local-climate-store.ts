import type { ClimateStore } from "./climate-store.ts";

const values = new Map<string, unknown>();

/** Development-only stand-in. Production always uses EdgeOne Blob. */
export const localClimateStore: ClimateStore = {
  async get(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
  async setJSON(key, value) { values.set(key, structuredClone(value)); },
  async delete(key) { values.delete(key); },
};
