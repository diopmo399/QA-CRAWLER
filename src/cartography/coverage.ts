import type {
  CartographyModel,
  MapConfidence,
  CoverageCriterion,
  CoverageStatus,
  CoverageSummary,
  Evidence,
  Feature,
  FeatureCoverage,
  FieldIssue,
  MapDecision,
  MapNode,
  ScenarioLink,
} from '../sdk/core/cartography.js';
import type { ExecutionFlowView } from '../sdk/core/contracts.js';

/**
 * LA COUVERTURE D'UNE FONCTIONNALITÉ PAR LES SCÉNARIOS, sur des critères mesurables :
 *   - un scénario y est ASSOCIÉ (proposé d'après ses étapes, ou ajouté et validé par une personne) ;
 *   - la fonctionnalité a été TRAVERSÉE : à la dernière exécution du scénario, les étapes qui l'atteignent
 *     ont réussi ;
 *   - une ASSERTION l'a VÉRIFIÉE : une attente du scénario porte sur son écran ou ses appels et a réussi ;
 *   - le TEST a RÉUSSI : la dernière exécution du scénario est passée ;
 *   - les CHAMPS CRITIQUES (obligatoires) du formulaire sont saisis par un scénario ;
 *   - un CHEMIN NÉGATIF (refus attendu : réponse 4xx) est joué.
 * Un critère non applicable sort du dénominateur, avec sa raison. Aucun pourcentage n'est inventé : sans
 * fonctionnalité à couvrir, la couverture est « non calculable ».
 */

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const RANK: Record<MapConfidence, number> = { CONFIRMED: 2, PROBABLE: 1, UNKNOWN: 0 };

export interface ScenarioInput {
  name: string;
  file: string;
  revision?: string;
  /** Le flow tel qu'écrit (YAML lu) : ses étapes, son adresse de départ, ses assertions. */
  flow: Raw;
}

export interface LastRun {
  run: string;
  at: string;
  verdict: string;
  /** Le flow de ce scénario dans l'exécution (absent : le scénario n'y a pas été joué). */
  flow?: ExecutionFlowView;
}

/** Le chemin d'une adresse (`http://hôte/requests/new?x` → `/requests/new`). */
function pathOf(url: string): string {
  const withoutOrigin = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const clean = withoutOrigin.split(/[?#]/)[0] ?? '';
  return `/${clean.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

/** Une route Angular (`requests/:id/edit`) comme expression : chaque paramètre accepte un segment. */
function routeMatches(route: string, url: string): boolean {
  const pattern = pathOf(route)
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}$`, 'i').test(pathOf(url));
}

/** Un chemin d'API (`/api/requests/{id}`) et une adresse observée (`/api/requests/**`, `/api/requests`). */
function apiMatches(path: string, observed: string): boolean {
  const expected = pathOf(path).replace(/\{[^}]*\}/g, '*');
  const seen = pathOf(observed);
  const toRegex = (value: string): RegExp =>
    new RegExp(
      `^${value
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.+')
        .replace(/\*/g, '[^/]+')}$`,
      'i',
    );
  return (
    toRegex(expected).test(seen) ||
    toRegex(seen).test(expected) ||
    seen.endsWith(expected) ||
    expected.endsWith(seen)
  );
}

interface StepMatch {
  /** Position dans le flow (à partir de 1), quand elle est celle du rapport d'exécution. */
  index?: number;
  confidence: MapConfidence;
  reason: string;
  field?: string;
  assertion?: boolean;
  negative?: boolean;
}

/** Ce qu'une fonctionnalité expose à un scénario : ses routes, ses champs saisis, ses appels. */
interface FeatureSurface {
  routes: MapNode[];
  fields: MapNode[];
  apis: { method: string; path: string }[];
}

function surfaceOf(model: CartographyModel, feature: Feature): FeatureSurface {
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const reached = feature.nodes.map((id) => nodes.get(id)).filter((n): n is MapNode => n !== undefined);
  return {
    routes: reached.filter((n) => n.kind === 'ROUTE'),
    fields: feature.fields
      .map((id) => nodes.get(id))
      .filter((n): n is MapNode => n?.kind === 'FIELD' && n.parent?.startsWith('COMPONENT:') === true),
    apis: reached
      .filter((n) => (n.kind === 'METHOD' && n.layer === 'FRONTEND') || n.kind === 'API')
      .map((n) => ({ method: String(n.detail.httpMethod ?? ''), path: String(n.detail.path ?? '') }))
      .filter((api) => api.method !== '' && api.path !== ''),
  };
}

/** Les étapes d'un flow, `run:` déplié (bornes : profondeur 3, 500 étapes) ; l'index n'est gardé qu'avant le premier `run:`. */
function stepsOf(
  flow: Raw,
  resolve: (name: string) => Raw | undefined,
  depth = 0,
): { step: Raw; index?: number; block?: string }[] {
  const out: { step: Raw; index?: number; block?: string }[] = [];
  let reliable = depth === 0;
  const steps = Array.isArray(flow.steps) ? flow.steps.filter(isObject) : [];
  steps.forEach((step, position) => {
    if (out.length > 500) return;
    if (typeof step.run === 'string') {
      reliable = false;
      const inner = depth < 3 ? resolve(step.run) : undefined;
      if (inner)
        for (const entry of stepsOf(inner, resolve, depth + 1))
          out.push({ step: entry.step, block: entry.block ?? step.run });
      return;
    }
    out.push({ step, ...(reliable ? { index: position + 1 } : {}) });
  });
  return out;
}

function matchesOf(
  scenario: ScenarioInput,
  surface: FeatureSurface,
  resolve: (name: string) => Raw | undefined,
): StepMatch[] {
  const matches: StepMatch[] = [];
  const startAt = typeof scenario.flow.startAt === 'string' ? scenario.flow.startAt : undefined;
  let onRoute = false;
  if (startAt)
    for (const route of surface.routes)
      if (routeMatches(route.name, startAt)) {
        onRoute = true;
        matches.push({
          confidence: 'CONFIRMED',
          reason: `le scénario démarre sur ${pathOf(startAt)}, l’adresse de l’écran ${route.name}`,
        });
      }
  for (const { step, index, block } of stepsOf(scenario.flow, resolve)) {
    const where = index !== undefined ? `l’étape ${String(index)}` : `une étape du bloc ${block ?? '?'}`;
    if (typeof step.goto === 'string')
      for (const route of surface.routes)
        if (routeMatches(route.name, step.goto)) {
          onRoute = true;
          matches.push({
            ...(index !== undefined ? { index } : {}),
            confidence: 'CONFIRMED',
            reason: `${where} ouvre ${pathOf(step.goto)}, l’adresse de l’écran ${route.name}`,
          });
        }
    const fill = isObject(step.fill) ? step.fill : isObject(step.select) ? step.select : undefined;
    if (fill) {
      const fingerprint = isObject(step.fingerprint) ? step.fingerprint : {};
      const label =
        typeof fill.label === 'string'
          ? fill.label
          : typeof fingerprint.label === 'string'
            ? fingerprint.label
            : undefined;
      const control = typeof fingerprint.formControl === 'string' ? fingerprint.formControl : undefined;
      for (const field of surface.fields) {
        const byControl = control !== undefined && control === field.name;
        const byLabel =
          label !== undefined &&
          field.label !== undefined &&
          label.trim().toLowerCase() === field.label.trim().toLowerCase();
        if (!byControl && !byLabel) continue;
        matches.push({
          ...(index !== undefined ? { index } : {}),
          // Un libellé peut se répéter d'un écran à l'autre : seul, il ne démontre pas l'écran.
          confidence: byControl || onRoute ? 'CONFIRMED' : 'PROBABLE',
          reason: byControl
            ? `${where} saisit le contrôle ${field.name} (empreinte enregistrée)`
            : `${where} saisit le champ « ${field.label ?? field.name} »${onRoute ? ' sur cet écran' : ' (libellé identique, écran non démontré)'}`,
          field: field.id,
        });
      }
    }
    if (isObject(step.expect)) {
      const expectation = step.expect;
      if (typeof expectation.url === 'string')
        for (const route of surface.routes)
          if (
            routeMatches(route.name, expectation.url) ||
            pathOf(expectation.url).includes(pathOf(route.name).replace(/\/:[^/]+/g, ''))
          )
            matches.push({
              ...(index !== undefined ? { index } : {}),
              confidence: 'CONFIRMED',
              reason: `${where} vérifie l’adresse ${expectation.url}`,
              assertion: true,
            });
      if (isObject(expectation.response) && typeof expectation.response.url === 'string') {
        const method =
          typeof expectation.response.method === 'string'
            ? expectation.response.method.toUpperCase()
            : undefined;
        const status = expectation.response.status;
        const negative =
          typeof status === 'number' ? status >= 400 : typeof status === 'string' && /^[45]xx$/.test(status);
        for (const api of surface.apis)
          if (
            (!method || method === api.method.toUpperCase()) &&
            apiMatches(api.path, expectation.response.url)
          ) {
            matches.push({
              ...(index !== undefined ? { index } : {}),
              confidence: 'CONFIRMED',
              reason: `${where} vérifie la réponse de ${method ?? '*'} ${expectation.response.url}${negative ? ` (refus attendu : ${String(status)})` : ''}`,
              assertion: true,
              negative,
            });
            break;
          }
      }
    }
  }
  return matches;
}

/** Les associations proposées d'après les étapes des scénarios (jamais validées d'office). */
export function proposeLinks(
  model: CartographyModel,
  scenarios: readonly ScenarioInput[],
  resolve: (name: string) => Raw | undefined = () => undefined,
): ScenarioLink[] {
  const links: ScenarioLink[] = [];
  for (const feature of model.features) {
    const surface = surfaceOf(model, feature);
    for (const scenario of scenarios) {
      const matches = matchesOf(scenario, surface, resolve);
      // Une saisie seule, par libellé, sur un écran non démontré ne suffit pas à proposer une association.
      if (!matches.some((m) => m.confidence === 'CONFIRMED') && matches.filter((m) => m.field).length < 2)
        continue;
      const confidence = matches.reduce<MapConfidence>(
        (best, m) => (RANK[m.confidence] > RANK[best] ? m.confidence : best),
        'UNKNOWN',
      );
      const evidence: Evidence[] = matches.map((m) => ({
        kind: 'SCENARIO_STEP',
        sourceId: 'scenarios',
        file: scenario.file,
        ...(m.index !== undefined ? { line: m.index } : {}),
        symbol: scenario.name,
        ...(scenario.revision ? { revision: scenario.revision } : {}),
        confidence: m.confidence,
        detail: m.reason,
      }));
      links.push({
        scenario: scenario.name,
        feature: feature.id,
        origin: 'AUTO',
        status: 'PROPOSED',
        path: matches.some((m) => m.negative) ? 'NEGATIVE' : 'POSITIVE',
        confidence,
        reasons: matches.map((m) => m.reason),
        evidence,
        fields: [...new Set(matches.map((m) => m.field).filter((f): f is string => f !== undefined))],
      });
    }
  }
  return links;
}

/**
 * Les associations après les décisions (dans l'ordre) : ajoutée, validée, rejetée, retirée. Une association
 * ajoutée à la main garde les preuves trouvées dans les étapes, s'il y en a.
 */
export function applyLinkDecisions(
  proposed: readonly ScenarioLink[],
  decisions: readonly MapDecision[],
): ScenarioLink[] {
  const key = (feature: string, scenario: string): string => `${feature}\u0000${scenario}`;
  const links = new Map(proposed.map((link) => [key(link.feature, link.scenario), structuredClone(link)]));
  for (const decision of [...decisions].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!decision.value) continue;
    const id = key(decision.target, decision.value);
    const link = links.get(id);
    switch (decision.kind) {
      case 'LINK_SCENARIO':
        links.set(id, {
          ...(link ?? {
            scenario: decision.value,
            feature: decision.target,
            confidence: 'CONFIRMED' as const,
            reasons: [],
            evidence: [],
            fields: [],
          }),
          origin: link?.origin ?? 'MANUAL',
          status: 'VALIDATED',
          path: decision.path ?? link?.path ?? 'POSITIVE',
          reasons: [
            ...(link?.reasons ?? []),
            `associé par ${decision.by ?? 'une personne'}${decision.note ? ` : ${decision.note}` : ''}`,
          ],
        });
        break;
      case 'VALIDATE_LINK':
        if (link)
          Object.assign(link, { status: 'VALIDATED', ...(decision.path ? { path: decision.path } : {}) });
        break;
      case 'REJECT_LINK':
        if (link) link.status = 'REJECTED';
        break;
      case 'UNLINK_SCENARIO':
        if (link?.origin === 'MANUAL') links.delete(id);
        else if (link) link.status = 'PROPOSED';
        break;
      default:
        break;
    }
  }
  return [...links.values()];
}

const LABELS: Record<CoverageCriterion['id'], string> = {
  LINKED: 'Scénario associé',
  TRAVERSED: 'Fonctionnalité traversée',
  ASSERTED: 'Assertion vérifiée',
  PASSED: 'Test réussi',
  CRITICAL_FIELDS: 'Champs obligatoires saisis',
  NEGATIVE_PATH: 'Chemin négatif joué',
};

export interface CoverageResult {
  coverage: FeatureCoverage[];
  summary: CoverageSummary;
  /** Les champs obligatoires qu'aucun scénario associé ne saisit. */
  issues: FieldIssue[];
}

export function computeCoverage(
  model: CartographyModel,
  links: readonly ScenarioLink[],
  lastRuns: ReadonlyMap<string, LastRun>,
  decisions: readonly MapDecision[],
  scenarios: readonly ScenarioInput[],
  resolve: (name: string) => Raw | undefined = () => undefined,
): CoverageResult {
  const outOfScope = new Set<string>();
  for (const decision of [...decisions].sort((a, b) => a.at.localeCompare(b.at)))
    if (decision.kind === 'OUT_OF_SCOPE') outOfScope.add(decision.target);
    else if (decision.kind === 'IN_SCOPE') outOfScope.delete(decision.target);
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const coverage: FeatureCoverage[] = [];
  const issues: FieldIssue[] = [];
  for (const feature of model.features) {
    if (feature.status === 'REJECTED') continue;
    const surface = surfaceOf(model, feature);
    const own = links.filter((link) => link.feature === feature.id && link.status !== 'REJECTED');
    const scenarioRows: FeatureCoverage['scenarios'] = [];
    let traversed = false;
    let asserted = false;
    let passed = false;
    for (const link of own) {
      const scenario = scenarios.find((entry) => entry.name === link.scenario);
      const matches = scenario ? matchesOf(scenario, surface, resolve) : [];
      const last = lastRuns.get(link.scenario);
      const flow = last?.flow;
      const stepOk = (index: number | undefined): boolean | undefined =>
        index === undefined
          ? undefined
          : flow?.steps.find((step) => step.index === index)?.status === 'PASSED';
      // Traversée : les étapes qui atteignent la fonctionnalité ont réussi (par leur position), sinon le flow entier.
      const positions = matches.map((m) => stepOk(m.index));
      const linkTraversed = flow
        ? positions.length > 0 &&
          positions.every((ok) => ok !== false) &&
          (positions.some((ok) => ok === true) || flow.status === 'PASSED')
        : undefined;
      const assertionSteps = matches.filter((m) => m.assertion);
      const linkAsserted = flow
        ? assertionSteps.some((m) => stepOk(m.index) ?? flow.status === 'PASSED') ||
          (flow.assertions.length > 0 &&
            linkTraversed === true &&
            flow.assertions.every((a) => a.status === 'PASSED'))
        : undefined;
      const linkPassed = flow ? flow.status === 'PASSED' : undefined;
      if (link.status === 'VALIDATED' || link.confidence === 'CONFIRMED') {
        traversed ||= linkTraversed === true;
        asserted ||= linkAsserted === true;
        passed ||= linkPassed === true;
      }
      scenarioRows.push({
        scenario: link.scenario,
        link: link.status,
        origin: link.origin,
        path: link.path,
        ...(last
          ? { lastRun: { run: last.run, verdict: flow ? flow.status : 'NOT_PLAYED', at: last.at } }
          : {}),
        ...(linkTraversed !== undefined ? { traversed: linkTraversed } : {}),
        assertions:
          assertionSteps.length +
          (scenario && Array.isArray(scenario.flow.assertions) ? scenario.flow.assertions.length : 0),
        ...(linkPassed !== undefined ? { passed: linkPassed } : {}),
        ...(linkAsserted !== undefined ? { asserted: linkAsserted } : {}),
      });
    }
    const counted = own.filter((link) => link.status === 'VALIDATED' || link.confidence === 'CONFIRMED');
    const required = surface.fields.filter((field) => field.detail.required === true);
    const filled = new Set(counted.flatMap((link) => link.fields));
    const untested = required.filter((field) => !filled.has(field.id)).map((field) => field.id);
    for (const field of untested)
      issues.push({
        kind: 'UNTESTED',
        fields: [field],
        message: `${nodes.get(field)?.label ?? nodes.get(field)?.name ?? field} : obligatoire, saisi par aucun scénario associé à « ${feature.name} »`,
      });
    const hasForm = surface.fields.some(
      (field) => (field.detail.validations as unknown[] | undefined)?.length,
    );
    const criteria: CoverageCriterion[] = [
      {
        id: 'LINKED',
        label: LABELS.LINKED,
        met: counted.length > 0,
        detail:
          counted.length > 0
            ? `${String(counted.length)} scénario(s) validé(s) ou démontré(s)`
            : own.length > 0
              ? `${String(own.length)} proposition(s) à confirmer`
              : 'aucun scénario associé',
      },
      {
        id: 'TRAVERSED',
        label: LABELS.TRAVERSED,
        met: traversed,
        detail: traversed
          ? 'les étapes qui l’atteignent ont réussi à la dernière exécution'
          : 'aucune exécution ne montre ces étapes réussies',
      },
      {
        id: 'ASSERTED',
        label: LABELS.ASSERTED,
        met: asserted,
        detail: asserted
          ? 'une attente sur son écran ou ses appels a réussi'
          : 'aucune attente réussie ne porte sur elle',
      },
      {
        id: 'PASSED',
        label: LABELS.PASSED,
        met: passed,
        detail: passed
          ? 'la dernière exécution d’un scénario associé est passée'
          : 'aucune exécution réussie d’un scénario associé',
      },
      required.length > 0
        ? {
            id: 'CRITICAL_FIELDS',
            label: LABELS.CRITICAL_FIELDS,
            met: untested.length === 0,
            detail: `${String(required.length - untested.length)} / ${String(required.length)} champ(s) obligatoire(s) saisi(s)`,
          }
        : {
            id: 'CRITICAL_FIELDS',
            label: LABELS.CRITICAL_FIELDS,
            detail: 'non applicable : aucun champ obligatoire identifié',
          },
      hasForm
        ? {
            id: 'NEGATIVE_PATH',
            label: LABELS.NEGATIVE_PATH,
            met: counted.some((link) => link.path === 'NEGATIVE'),
            detail: counted.some((link) => link.path === 'NEGATIVE')
              ? 'un scénario joue un refus attendu'
              : 'aucun scénario ne joue de refus (réponse 4xx attendue)',
          }
        : {
            id: 'NEGATIVE_PATH',
            label: LABELS.NEGATIVE_PATH,
            detail: 'non applicable : aucune règle de validation identifiée',
          },
    ];
    const applicable = criteria.filter((c) => c.met !== undefined);
    const met = applicable.filter((c) => c.met === true).length;
    const status: CoverageStatus = outOfScope.has(feature.id)
      ? 'OUT_OF_SCOPE'
      : own.length === 0
        ? 'NOT_COVERED'
        : counted.length === 0
          ? 'TO_CONFIRM'
          : met === applicable.length
            ? 'COVERED'
            : 'PARTIAL';
    const recommendations: string[] = [];
    if (status === 'NOT_COVERED')
      recommendations.push('Associer un scénario existant, ou en enregistrer un qui ouvre cet écran.');
    if (status === 'TO_CONFIRM') recommendations.push('Valider ou rejeter les associations proposées.');
    if (counted.length > 0 && !traversed)
      recommendations.push(
        'Exécuter les scénarios associés (aucune exécution ne traverse la fonctionnalité).',
      );
    if (counted.length > 0 && !asserted)
      recommendations.push(
        'Ajouter une attente sur l’écran ou la réponse de l’appel (expect url / response).',
      );
    for (const field of untested.slice(0, 5))
      recommendations.push(
        `Saisir le champ obligatoire « ${nodes.get(field)?.label ?? nodes.get(field)?.name ?? field} » dans un scénario.`,
      );
    if (hasForm && !counted.some((link) => link.path === 'NEGATIVE'))
      recommendations.push('Ajouter un scénario négatif (saisie refusée, réponse 4xx attendue).');
    coverage.push({
      feature: feature.id,
      status,
      criteria,
      met,
      applicable: applicable.length,
      formula: `${String(met)} critère(s) rempli(s) sur ${String(applicable.length)} applicable(s)`,
      scenarios: scenarioRows,
      untestedFields: untested,
      recommendations: status === 'OUT_OF_SCOPE' ? [] : recommendations,
    });
  }
  const counts: Record<CoverageStatus, number> = {
    COVERED: 0,
    PARTIAL: 0,
    NOT_COVERED: 0,
    TO_CONFIRM: 0,
    OUT_OF_SCOPE: 0,
  };
  for (const entry of coverage) counts[entry.status] += 1;
  const denominator = coverage.length - counts.OUT_OF_SCOPE;
  const summary: CoverageSummary = {
    counts,
    ...(denominator > 0 ? { percent: Math.round((counts.COVERED / denominator) * 1000) / 10 } : {}),
    numerator: counts.COVERED,
    denominator,
    formula:
      denominator > 0
        ? `fonctionnalités couvertes (${String(counts.COVERED)}) / fonctionnalités dans le périmètre (${String(denominator)} = ${String(coverage.length)} − ${String(counts.OUT_OF_SCOPE)} hors périmètre ; les rejetées ne comptent pas)`
        : 'non calculable : aucune fonctionnalité dans le périmètre',
  };
  return { coverage, summary, issues };
}
