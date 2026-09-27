/** Bounded TTL cache. Concurrent readers share one load; failures are never cached. */
export function createAsyncCache({ maxEntries = 128, now = Date.now } = {}) {
  const entries = new Map();
  const pending = new Map();
  return {
    get(key, load, ttlMs) {
      const saved = entries.get(key);
      if (saved && saved.expires > now()) return Promise.resolve(saved.value);
      if (pending.has(key)) return pending.get(key);
      const request = Promise.resolve().then(load).then((value) => {
        const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
        entries.delete(key);
        entries.set(key, { value, expires: now() + ttl });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },
  };
}
