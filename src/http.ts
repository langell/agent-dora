import { MS_PER_SECOND, TOOL_NAME } from './constants.js';

/** Statuses worth retrying: rate limits and transient gateway errors. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;
const BACKOFF_BASE_SECONDS = 2;
/** How much of an error response body to quote. */
const ERROR_BODY_CHARS = 300;

/** A failed HTTP request, with the status so callers can tell "no access" from other failures. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP statuses meaning the credentials can't read this. */
export const ACCESS_DENIED = new Set([401, 403, 404]);

/**
 * GETs or POSTs JSON, retrying rate limits and transient errors with backoff
 * (honouring `retry-after`). `what` names the service in error messages.
 */
export async function fetchJson<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const headers = { 'user-agent': TOOL_NAME, accept: 'application/json', ...(init.headers as Record<string, string>) };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers });
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      const waitSeconds = Number(res.headers.get('retry-after')) || 2 ** attempt * BACKOFF_BASE_SECONDS;
      await new Promise((r) => setTimeout(r, waitSeconds * MS_PER_SECOND));
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, `${what} request failed (${res.status}): ${(await res.text()).slice(0, ERROR_BODY_CHARS)}`);
    return (await res.json()) as T;
  }
}
