import type { SourceCache } from "./types.ts";

/** In-process TTL cache. Expired entries are evicted on read. */
export function createMemorySourceCache(now: () => number = Date.now): SourceCache {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (ttlMs <= 0) return;
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
  };
}
