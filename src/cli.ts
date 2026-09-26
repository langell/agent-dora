#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on Node 22; it's stable enough for a cache.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes('SQLite')) return;
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import('./main.js');
main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`agent-dora: ${err.message}`);
  process.exit(1);
});
