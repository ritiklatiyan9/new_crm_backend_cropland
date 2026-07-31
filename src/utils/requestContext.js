// Per-request context via AsyncLocalStorage — lets deep helpers (e.g. the audit
// logger) read request-scoped data (client IP) without threading it through every call.

import { AsyncLocalStorage } from 'node:async_hooks';

export const requestStore = new AsyncLocalStorage();

/** Client IP for the current request, if available. */
export function getRequestIp() {
  return requestStore.getStore()?.ip ?? null;
}
