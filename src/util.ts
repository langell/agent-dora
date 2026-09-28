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
