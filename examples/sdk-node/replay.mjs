// Exemple : le SDK QA-CRAWLER dans un programme Node (script, CI, outil interne).
//
//   npm run build
//   node examples/sdk-node/replay.mjs --workspace <dossier> --project <nom|id> [--env <nom|id>]
//                                     [--scenario <nom>]... [--json]
//
// Le programme ouvre le service du SDK dans le programme même (127.0.0.1, port libre, jeton jamais affiché),
// rejoue les scénarios du projet par le moteur, suit les étapes en direct, puis lit le verdict écrit
// sur disque. Ctrl+C annule proprement (le moteur s'arrête avant l'action suivante et écrit son
// rapport) ; un second Ctrl+C quitte tout de suite.
//
// Codes de sortie : 0 réussi · 1 échoué · 2 usage (projet ou environnement introuvable)
//                   3 exécution impossible ou sans verdict · 130 annulé.
import { parseArgs } from 'node:util';
import { openQaCrawler } from '@qa-crawler/core/sdk/server';

const EXIT = { PASSED: 0, FAILED: 1, USAGE: 2, RUNTIME: 3, CANCELLED: 130 };

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    project: { type: 'string' },
    env: { type: 'string' },
    scenario: { type: 'string', multiple: true },
    json: { type: 'boolean', default: false },
  },
});
if (!values.workspace || !values.project) {
  console.error(
    'usage: replay.mjs --workspace <dir> --project <name|id> [--env <name|id>] [--scenario <name>]... [--json]',
  );
  process.exit(EXIT.USAGE);
}

const log = (line) => {
  if (!values.json) console.log(line);
};
const byNameOrId = (entries, key) => entries.find((entry) => entry.id === key || entry.name === key);

const qa = await openQaCrawler({ workspace: values.workspace, language: 'fr' });
let code = EXIT.RUNTIME;
try {
  code = await replay(qa.client);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await qa.close();
}
process.exit(code);

async function replay(client) {
  const project = byNameOrId(await client.projects.list(), values.project);
  if (!project) {
    console.error(`project not found: ${values.project}`);
    return EXIT.USAGE;
  }
  let environment;
  if (values.env) {
    environment = byNameOrId(await client.environments.list(project.id), values.env);
    if (!environment) {
      console.error(`environment not found: ${values.env}`);
      return EXIT.USAGE;
    }
  }

  const started = await client.executions.start(project.id, {
    ...(environment ? { environmentId: environment.id } : {}),
    ...(values.scenario ? { scenarios: values.scenario } : {}),
  });
  log(`▶ ${project.name}${environment ? ` · ${environment.name}` : ''} · run ${started.run ?? '?'}`);

  // Ctrl+C : le premier annule par le SDK, le second quitte.
  let cancelling = false;
  const onSignal = () => {
    if (cancelling) process.exit(EXIT.CANCELLED);
    cancelling = true;
    log('… cancellation requested (Ctrl+C again to exit now)');
    client.explorations.cancel(started.id).catch(() => undefined);
  };
  process.on('SIGINT', onSignal);
  try {
    await new Promise((resolve) => {
      const subscription = client.explorations.subscribe(started.id, (event) => {
        if (event.type === 'flow-step')
          log(`  ${event.status.padEnd(7)} ${String(event.index)}. ${event.label}`);
        if (event.type === 'completed' || event.type === 'failed') {
          subscription.close();
          resolve();
        }
      });
    });
  } finally {
    process.off('SIGINT', onSignal);
  }

  const status = await client.explorations.status(started.id);
  if (status.status === 'FAILED' || !started.run) {
    console.error(`the execution could not run: ${status.error ?? status.status}`);
    return EXIT.RUNTIME;
  }
  const detail = await client.executions.get(project.id, started.run);
  if (values.json) {
    console.log(
      JSON.stringify({
        project: project.id,
        run: detail.run,
        verdict: detail.verdict,
        environment: detail.environment ?? null,
        flows: detail.flows,
        assertions: detail.flowsDetail.flatMap((flow) =>
          flow.assertions.map((assertion) => ({
            flow: flow.name,
            id: assertion.id,
            status: assertion.status,
          })),
        ),
      }),
    );
  } else {
    log(`■ ${detail.verdict} — ${String(detail.flows.passed)}/${String(detail.flows.total)} flow(s) passed`);
  }
  return EXIT[detail.verdict] ?? EXIT.RUNTIME;
}
