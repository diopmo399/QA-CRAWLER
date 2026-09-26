import { startTestSite } from './test-site.js';

/** Serves the test site on a fixed port for manual runs: `npm run demo:server`, then `npm run qa -- scenarios/demo.yaml`. */
const port = Number(process.env.PORT ?? 4173);
const site = await startTestSite(port);
console.log(`Demo site listening on ${site.url} (Ctrl+C to stop)`);

process.on('SIGINT', () => {
  if (site.dangerousHits.length > 0)
    console.log(`Dangerous endpoints reached: ${site.dangerousHits.join(', ')}`);
  void site.close().then(() => process.exit(0));
});
