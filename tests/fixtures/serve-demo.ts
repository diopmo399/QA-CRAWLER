import { startFlowApp } from './flow-app.js';
import { startTestSite } from './test-site.js';

/**
 * Sert les applications de démonstration pour les lancements manuels :
 *   npm run demo:server
 *   npm run qa -- scenarios/demo.yaml        (flows du back-office, port 4174)
 *   npm run qa -- scenarios/demo-traps.yaml  (pièges à bugs, port 4173)
 */
const traps = await startTestSite(Number(process.env.TRAPS_PORT ?? 4173));
const app = await startFlowApp(Number(process.env.APP_PORT ?? 4174));
console.log(`Trap site   : ${traps.url}`);
console.log(`Back-office : ${app.url}`);
console.log('(Ctrl+C to stop)');

process.on('SIGINT', () => {
  const hits = [...traps.dangerousHits, ...app.dangerousHits];
  console.log(
    hits.length > 0
      ? `Dangerous endpoints reached: ${hits.join(', ')}`
      : 'No dangerous endpoint was reached.',
  );
  void Promise.all([traps.close(), app.close()]).then(() => process.exit(0));
});
