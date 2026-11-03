/**
 * ÉTAPE `run` : rejouer un autre flow à cet endroit (une précondition comme « une
 * demande est créée », écrite une fois, en YAML ou en Gherkin). Les étapes du flow
 * rejoué sont recopiées avant la validation : le reste du moteur ne voit que des
 * étapes ordinaires, avec leurs propres `allow`.
 *
 *   flows:
 *     - name: creer-dossier
 *       reusable: true          # rejoué par `run`, jamais exécuté seul
 *       steps: [...]
 *     - name: modifier-dossier
 *       steps:
 *         - run: creer-dossier
 *         - click: { role: button, name: Modifier }
 *
 * `with:` (à côté de `run`) renomme les données du flow rejoué dans les étapes recopiées
 * (`testData` et `${testData:…}`) : `- run: creer-dossier` suivi de `with: { dossier.code: dossier2.code }`
 * rejoue le même flow avec une autre donnée, sans toucher au flow rejoué.
 *
 * Travaille sur le YAML brut (avant zod) ; les erreurs sont des messages pour l'utilisateur.
 */

type RawFlow = Record<string, unknown>;
type RawStep = Record<string, unknown>;

const STEP_KINDS = [
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'expect',
  'screenshot',
  'manual',
  'auto',
];

export class FlowIncludeError extends Error {}

/** Remplace chaque étape `run` par les étapes du flow nommé, puis retire les flows `reusable`. */
export function resolveFlowRuns(flows: readonly unknown[]): unknown[] {
  const byName = new Map<string, RawFlow>();
  for (const flow of flows) if (isObject(flow) && typeof flow.name === 'string') byName.set(flow.name, flow);
  if (!flows.some((flow) => isObject(flow) && (flow.reusable !== undefined || hasRun(flow))))
    return [...flows];

  const resolved = new Map<string, RawStep[]>();
  const stepsOf = (name: string, chain: string[]): RawStep[] => {
    const done = resolved.get(name);
    if (done) return done;
    if (chain.includes(name))
      throw new FlowIncludeError(`flows: "run" loop ${[...chain, name].map((n) => `"${n}"`).join(' → ')}`);
    const flow = byName.get(name);
    const steps = Array.isArray(flow?.steps) ? (flow.steps as unknown[]) : [];
    const expanded = steps.flatMap((step): unknown[] => {
      if (!isObject(step) || step.run === undefined) return [step];
      if (typeof step.run !== 'string' || step.run.trim() === '')
        throw new FlowIncludeError(`flow "${name}": "run" needs the name of a flow`);
      // `allow` d'une phrase Gherkin taguée n'élargit pas le flow rejoué : ses étapes gardent leurs propres droits.
      const extra = Object.keys(step).filter(
        (key) => !['run', 'name', 'allow', 'optional', 'with'].includes(key),
      );
      if (extra.length > 0)
        throw new FlowIncludeError(
          `flow "${name}": a "run" step only takes a name (got ${extra.join(', ')})`,
        );
      const target = step.run.trim();
      if (!byName.has(target))
        throw new FlowIncludeError(`flow "${name}": run "${target}": no flow has this name`);
      const mapping = runMapping(name, target, step.with);
      const outer = typeof step.name === 'string' ? step.name : `run ${target}`;
      return stepsOf(target, [...chain, name]).map((inner) => ({
        ...(mapping ? (renameTestData(inner, mapping) as RawStep) : inner),
        ...(step.optional === true ? { optional: true } : {}),
        name: `${outer} › ${typeof inner.name === 'string' ? inner.name : labelOf(inner)}`,
      }));
    }) as RawStep[];
    resolved.set(name, expanded);
    return expanded;
  };

  return flows
    .filter((flow) => !(isObject(flow) && flow.reusable === true))
    .map((flow) => {
      if (!isObject(flow) || typeof flow.name !== 'string' || !Array.isArray(flow.steps)) return flow;
      const { reusable: _reusable, ...rest } = flow;
      return { ...rest, steps: stepsOf(flow.name, []) };
    });
}

const DATA_KEY = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

/**
 * `with:` d'une étape `run` : la correspondance des données de CETTE instance du bloc rejoué
 * (`{ cléDuBloc: cléDuScénario }`). Les étapes recopiées lisent alors la clé du scénario à la place de
 * celle du bloc ; le bloc lui-même n'est pas modifié. Deux instances d'un même bloc peuvent ainsi lire
 * des données différentes sans s'écraser.
 */
function runMapping(name: string, target: string, raw: unknown): Map<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw))
    throw new FlowIncludeError(`flow "${name}": run "${target}": "with" maps data keys to data keys`);
  const mapping = new Map<string, string>();
  for (const [from, to] of Object.entries(raw)) {
    if (!DATA_KEY.test(from) || typeof to !== 'string' || !DATA_KEY.test(to))
      throw new FlowIncludeError(
        `flow "${name}": run "${target}": "with" needs data keys (got ${from}: ${String(to)})`,
      );
    mapping.set(from, to);
  }
  return mapping.size > 0 ? mapping : undefined;
}

/** Les références `{ testData: clé }` et `${testData:clé}` d'une étape, renommées selon `with:`. */
export function renameTestData(node: unknown, mapping: ReadonlyMap<string, string>): unknown {
  if (typeof node === 'string')
    return node.replace(/\$\{testData:([^}]+)\}/g, (whole, key: string) => {
      const target = mapping.get(key.trim());
      return target ? `\${testData:${target}}` : whole;
    });
  if (Array.isArray(node)) return node.map((item) => renameTestData(item, mapping));
  if (!isObject(node)) return node;
  if (typeof node.testData === 'string' && Object.keys(node).length === 1)
    return { testData: mapping.get(node.testData) ?? node.testData };
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, renameTestData(value, mapping)]),
  );
}

function hasRun(flow: RawFlow): boolean {
  return Array.isArray(flow.steps) && flow.steps.some((step) => isObject(step) && step.run !== undefined);
}

/** Libellé court d'une étape brute sans nom : `click "Enregistrer"`, `goto /x`. */
export function labelOf(step: RawStep): string {
  const kind = STEP_KINDS.find((candidate) => step[candidate] !== undefined) ?? 'step';
  const value = step[kind];
  if (typeof value === 'string') return `${kind} ${value}`;
  if (isObject(value)) {
    const target = ['name', 'label', 'text', 'testId', 'css', 'url', 'sentence']
      .map((key) => value[key])
      .find((candidate) => typeof candidate === 'string');
    if (typeof target === 'string') return `${kind} "${target}"`;
  }
  return kind;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
