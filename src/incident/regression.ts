import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { redactText } from '../security/redactor.js';
import { quotedTextsIn } from './evidence.js';
import type { HttpExchange, Incident, RegressionTestProposal } from './model.js';

/**
 * LE TEST DE NON-RÉGRESSION : le flow du scénario qui mène au symptôme, rejoué tel quel, plus des
 * attentes au format de la bibliothèque (`expect: { response }`, `expect: { noError }`,
 * `expect: { text }`). Toujours PROPOSED ici : ni ajouté à la bibliothèque, ni exécuté.
 */

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Le flow du scénario dans son YAML : `flows: [...]` (par nom, sinon le premier) ou un flow seul. */
function flowOf(document: unknown, scenarioName: string): Raw | undefined {
  if (!isObject(document)) return undefined;
  if (Array.isArray(document.flows)) {
    const flows = document.flows.filter(isObject);
    return flows.find((flow) => flow.name === scenarioName) ?? flows[0];
  }
  return Array.isArray(document.steps) ? document : undefined;
}

/** Un chemin observé en motif de la bibliothèque : les identifiants (nombres, UUID) deviennent `*`. */
export function responsePattern(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
        ? '*'
        : segment,
    )
    .join('/');
}

/** La requête qui a déclenché le symptôme dans la dernière reproduction : une écriture d'API en erreur d'abord. */
function triggeringRequest(incident: Incident): HttpExchange | undefined {
  const requests = incident.investigation.reproductions.at(-1)?.requests ?? [];
  const failing = requests.filter((request) => (request.status ?? 0) >= 400 || request.failure !== undefined);
  const score = (request: HttpExchange): number =>
    ((request.status ?? 0) >= 500 ? 4 : 0) +
    (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase()) ? 2 : 0) +
    (request.resourceType === 'xhr' || request.resourceType === 'fetch' ? 1 : 0);
  return [...failing].sort((left, right) => score(right) - score(left))[0];
}

/** Un endpoint du périmètre (« POST /api/books ») quand aucune reproduction n'a montré la requête. */
function scopeEndpoint(incident: Incident): { method: string; path: string } | undefined {
  for (const endpoint of incident.scope.endpoints) {
    const match = /^([A-Z]+)\s+(\/\S*)$/.exec(endpoint.trim());
    if (match?.[1] && match[2]) return { method: match[1], path: match[2] };
  }
  return undefined;
}

export function proposeRegressionTest(input: {
  incident: Incident;
  scenarioName: string;
  scenarioYaml: string;
}): RegressionTestProposal {
  const { incident, scenarioName } = input;
  const source = flowOf(parseYaml(input.scenarioYaml), scenarioName);
  const steps = Array.isArray(source?.steps) ? (source.steps as unknown[]) : [];
  if (!source || steps.length === 0) throw new Error(`scenario "${scenarioName}" has no flow with steps`);

  const name = `Non-régression — ${redactText(incident.title).replace(/\s+/g, ' ').trim()}`;
  const trigger = triggeringRequest(incident);
  const endpoint = trigger
    ? { method: trigger.method.toUpperCase(), path: trigger.path }
    : scopeEndpoint(incident);
  const expected: string[] = [];

  // Juste après l'étape qui a déclenché la requête (sinon à la fin) : elle doit réussir, sans message d'erreur.
  const checks: Raw[] = [];
  if (endpoint) {
    checks.push({
      name: `${endpoint.method} ${endpoint.path} ne renvoie plus d'erreur`,
      expect: { response: { method: endpoint.method, url: responsePattern(endpoint.path), status: '2xx' } },
    });
    expected.push(
      `${endpoint.method} ${endpoint.path} répond en 2xx (plus de ${trigger?.status !== undefined ? String(trigger.status) : 'erreur'})`,
    );
  }
  checks.push({ name: "Aucun message d'erreur affiché", expect: { noError: true } });
  expected.push("aucun message d'erreur affiché");

  const position =
    trigger?.step !== undefined && trigger.step >= 1 && trigger.step <= steps.length
      ? trigger.step
      : steps.length;
  const flowSteps: unknown[] = [...steps.slice(0, position), ...checks, ...steps.slice(position)];
  // Le résultat attendu, quand l'incident le cite entre guillemets.
  for (const text of quotedTextsIn(incident.expected)) {
    flowSteps.push({ name: `Résultat attendu : ${text}`, expect: { text } });
    expected.push(`« ${text} » affiché`);
  }

  const flow: Raw = {
    name,
    description: `Proposé par l'investigation de l'incident ${incident.id} à partir du scénario « ${scenarioName} ». Attendu : ${redactText(incident.expected)}`,
    ...(typeof source.startAt === 'string' ? { startAt: source.startAt } : {}),
    ...(source.testData !== undefined ? { testData: source.testData } : {}),
    steps: flowSteps,
  };

  return {
    name,
    basedOn: scenarioName,
    flowYaml: stringifyYaml({ flows: [flow] }, { lineWidth: 0 }),
    expected: expected.join(' ; '),
    status: 'PROPOSED',
  };
}
