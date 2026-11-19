export const hosted = import.meta.env.MODE === "webos" ||
  (typeof window !== "undefined" && new URLSearchParams(window.location?.search).get("host") === "webos-account");

// Standalone preferences and recent filenames must never cross WebOS account sessions.
const entries = new Map<string, string>();
const temporary: Storage = {
  get length() { return entries.size; },
  key(i: number) { return [...entries.keys()][i] ?? null; },
  getItem(key: string) { return entries.get(key) ?? null; },
  setItem(key: string, value: string) { entries.set(key, value); },
  removeItem(key: string) { entries.delete(key); },
  clear() { entries.clear(); }
};
export function preferences() { return hosted ? temporary : globalThis.localStorage; }
