// TESTS UNIQUEMENT : les imports publiés `@qa-crawler/core/…` résolus vers les sources (src/), pour
// exécuter un exemple sans construire dist/. À charger après tsx :
//   node --import tsx --import ./tests/fixtures/source-packages.ts examples/…
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
const SOURCES = ${JSON.stringify({
      '@qa-crawler/core/sdk/server': new URL('../../src/sdk/server/index.ts', import.meta.url).href,
      '@qa-crawler/core/sdk': new URL('../../src/sdk/core/index.ts', import.meta.url).href,
      '@qa-crawler/core': new URL('../../src/index.ts', import.meta.url).href,
    })};
export async function resolve(specifier, context, next) {
  const url = SOURCES[specifier];
  return url ? { url, shortCircuit: true } : next(specifier, context);
}
`),
);
