#!/usr/bin/env node
import { TOOL_NAME } from './constants.js';

// node:sqlite prints an ExperimentalWarning on Node 22; it's stable enough for a cache.
const SUPPRESSED_WARNING = 'SQLite';
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes(SUPPRESSED_WARNING)) return;
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

// Imported after the warning filter is installed, since loading it loads node:sqlite.
const { main } = await import('./main.js');
main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`${TOOL_NAME}: ${err.message}`);
  process.exit(1);
});
