// Tiny in-memory cache with a time-to-live, for cheap public GET endpoints.
// Per server process; a restart simply starts empty.
export function createTtlCache({ ttlMs, maxEntries = 200 }) {
  const store = new Map();

  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expires <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (store.size >= maxEntries) store.delete(store.keys().next().value); // oldest first
      store.set(key, { value, expires: Date.now() + ttlMs });
    },
    clear() {
      store.clear();
    },
  };
}
