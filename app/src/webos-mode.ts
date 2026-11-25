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


const appearanceKeys = new Set(["sketchcraft.skin", "sketchcraft.skinData", "sketchcraft.layout"]);

/** Only the appearance choices use the profile that the same-origin Desktop supplies. */
export function appearanceStorage(key: string): { storage: Storage; key: string } | null {
  if (!hosted || !appearanceKeys.has(key)) return null;
  const profile = new URLSearchParams(window.location.search).get("profile") ?? "";
  if (!/^(?:(?:user|anon):)?[a-f0-9-]{36}$/i.test(profile)) return null;
  const storage = profile.startsWith("user:") ? window.localStorage : window.sessionStorage;
  return { storage, key: `webos.${profile}.${key}` };
}
