#!/usr/bin/env node
import { runCli } from './cli/cli.js';

/**
 * Le travail est fini : le processus se termine. Un client resté ouvert (runtime d'intelligence,
 * connexion d'un navigateur, base de données) ne doit jamais laisser le terminal « en attente » :
 * après un court délai de grâce, la sortie est forcée (minuterie détachée : sans effet si rien ne reste).
 */
const EXIT_GRACE_MS = 3_000;
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => {
    process.exit(code);
  }, EXIT_GRACE_MS).unref();
}

runCli(process.argv.slice(2))
  .then(finish)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    finish(3);
  });
