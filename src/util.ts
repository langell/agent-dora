import { availableParallelism } from 'node:os';

/** Log a progress line once every this many items. */
export const PROGRESS_EVERY = 25;

/** Returns a callback to call after each item; it logs "  n/total" every `PROGRESS_EVERY` items. */
export function progress(log: (msg: string) => void, total: number): () => void {
  let done = 0;
  return () => {
    done++;
    if (done % PROGRESS_EVERY === 0) log(`  ${done}/${total}`);
  };
}

/**
 * How many changes to measure at once. Each runs several `git blame` processes,
 * so this is capped below the core count to leave room for git's own work.
 */
const MAX_GIT_CONCURRENCY = 8;
export const GIT_CONCURRENCY = Math.min(MAX_GIT_CONCURRENCY, availableParallelism());

/**
 * Maps `items` through `fn` with at most `limit` calls in flight.
 * Results keep the input order, whatever order the calls finish in.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
