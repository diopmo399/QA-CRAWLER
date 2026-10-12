#!/usr/bin/env node
// @qa-crawler/cli — la façade : tout le travail est fait par @qa-crawler/core (les moteurs existants).
import { readFile } from 'node:fs/promises';
import { runCli } from '@qa-crawler/core/cli';

const EXIT_GRACE_MS = 3_000;
function finish(code) {
  process.exitCode = code;
  setTimeout(() => {
    process.exit(code);
  }, EXIT_GRACE_MS).unref();
}

let cliVersion;
try {
  cliVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch {
  cliVersion = undefined;
}

runCli(process.argv.slice(2), { cliVersion })
  .then(finish)
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    finish(3);
  });
