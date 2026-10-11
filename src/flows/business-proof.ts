import type { FlowRunReport, FlowStepReport, StepRequestReport } from '../model/flow-run.js';

/**
 * PREUVE MÉTIER d'un flow exécuté : « PASSED » étape par étape ne dit pas si le parcours a prouvé son
 * objectif. Ici, pour une donnée de test réutilisée (CREATE → SEARCH → OPEN) :
 *
 *   - CREATE : l'étape qui la saisit en premier, suivie d'une écriture acceptée (POST/PUT/PATCH 2xx-3xx) ;
 *   - SEARCH : une saisie ultérieure de la MÊME donnée (le critère de recherche), et la requête envoyée ;
 *   - OPEN   : un geste ultérieur dont la cible CITE la donnée (le résultat qui la porte), et sa lecture.
 *
 * Tout vient des étapes du run (leurs données citées, leurs requêtes, leur statut) : déterministe,
 * aucune valeur lue, aucun corps de requête. Une étape manquante donne PARTIAL avec ce qui manque ;
 * aucune donnée réutilisée : NOT_APPLICABLE.
 */
export type BusinessProofStatus = 'PROVEN' | 'PARTIAL' | 'NOT_PROVEN' | 'NOT_APPLICABLE';

export interface BusinessProofStage {
  step: number;
  description: string;
  status: FlowStepReport['status'];
  request?: string;
}

export interface BusinessProofReport {
  status: BusinessProofStatus;
  /** La donnée de test suivie (la première réutilisée par plusieurs étapes). */
  key?: string;
  creation?: BusinessProofStage;
  search?: BusinessProofStage;
  open?: BusinessProofStage;
  evidence: string[];
  missing: string[];
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const accepted = (request: StepRequestReport): boolean =>
  request.status !== undefined && request.status >= 200 && request.status < 400;
const label = (request: StepRequestReport): string =>
  `${request.method.toUpperCase()} ${request.path}${request.status !== undefined ? ` → ${String(request.status)}` : ''}`;

function stage(step: FlowStepReport, request?: StepRequestReport): BusinessProofStage {
  return {
    step: step.index,
    description: step.description,
    status: step.status,
    ...(request ? { request: label(request) } : {}),
  };
}

export function businessProofOf(flow: FlowRunReport): BusinessProofReport {
  const entries = flow.testDataReport?.entries ?? [];
  const steps = flow.steps;
  const at = (index: number): FlowStepReport | undefined => steps.find((step) => step.index === index);
  // La donnée suivie : produite par une saisie, puis réutilisée (saisie ou citation) plus loin.
  const tracked = entries.find(
    (entry) =>
      entry.producedAt !== undefined && entry.usedBy.some((use) => use.step > (entry.producedAt ?? 0)),
  );
  if (!tracked)
    return { status: 'NOT_APPLICABLE', evidence: ['no test datum is reused by a later step'], missing: [] };
  const evidence: string[] = [];
  const missing: string[] = [];
  const produced = tracked.producedAt ?? 0;
  const later = tracked.usedBy.filter((use) => use.step > produced);
  const firstLater = later[0]?.step ?? Number.POSITIVE_INFINITY;

  // CREATE : la première écriture acceptée entre la saisie et la réutilisation suivante.
  let creation: BusinessProofStage | undefined;
  for (const step of steps) {
    if (step.index < produced || step.index >= firstLater) continue;
    const write = step.network?.requests.find(
      (request) => WRITES.has(request.method.toUpperCase()) && accepted(request),
    );
    if (write) {
      creation = stage(step, write);
      evidence.push(
        `CREATE: testData.${tracked.key} typed at step ${String(produced)}, then ${label(write)} at step ${String(step.index)}`,
      );
      break;
    }
  }
  if (!creation)
    missing.push(`no accepted write after the input of testData.${tracked.key} (step ${String(produced)})`);

  // SEARCH : une saisie ultérieure de la même donnée, et la requête qu'elle (ou le geste suivant) envoie.
  const searchUse = later.find((use) => use.how === 'INPUT' && use.step > (creation?.step ?? produced));
  let search: BusinessProofStage | undefined;
  if (searchUse) {
    const input = at(searchUse.step);
    const nextCitation =
      later.find((use) => use.how === 'CITATION' && use.step > searchUse.step)?.step ??
      Number.POSITIVE_INFINITY;
    const sent = steps
      .filter((step) => step.index >= searchUse.step && step.index < nextCitation)
      .flatMap((step) =>
        (step.network?.requests ?? []).filter(accepted).map((request) => ({ step, request })),
      )
      .find((candidate) => candidate.request.resourceType !== 'document');
    if (input) {
      search = { ...stage(input, sent?.request), ...(sent ? { request: label(sent.request) } : {}) };
      evidence.push(
        `SEARCH: testData.${tracked.key} typed again at step ${String(searchUse.step)}${sent ? `, sent as ${label(sent.request)} (step ${String(sent.step.index)})` : ' (no request observed)'}`,
      );
    }
  } else missing.push(`testData.${tracked.key} is never typed again (no search by the created value)`);

  // OPEN : un geste dont la cible cite la donnée (le résultat qui la porte), et sa lecture.
  const openUse = later.find(
    (use) => use.how === 'CITATION' && use.step > (search?.step ?? creation?.step ?? produced),
  );
  let open: BusinessProofStage | undefined;
  if (openUse) {
    const click = at(openUse.step);
    const read = click?.network?.requests.find(
      (request) =>
        request.method.toUpperCase() === 'GET' && accepted(request) && request.resourceType !== 'document',
    );
    if (click) {
      open = stage(click, read);
      evidence.push(
        `OPEN: the target of step ${String(openUse.step)} cites testData.${tracked.key} (the result carrying the created value)${read ? `, read by ${label(read)}` : ''}${click.url ? `, route ${click.url}` : ''}`,
      );
    }
  } else
    missing.push(
      `no later step whose target cites testData.${tracked.key} (the created result is never opened)`,
    );

  const passed = (candidate: BusinessProofStage | undefined): boolean => candidate?.status === 'PASSED';
  const status: BusinessProofStatus =
    passed(creation) && passed(search) && passed(open)
      ? 'PROVEN'
      : creation || search || open
        ? [creation, search, open].some((candidate) => candidate && candidate.status !== 'PASSED')
          ? 'NOT_PROVEN'
          : 'PARTIAL'
        : 'NOT_PROVEN';
  for (const candidate of [creation, search, open])
    if (candidate && candidate.status !== 'PASSED')
      missing.push(`step ${String(candidate.step)} is ${candidate.status}: ${candidate.description}`);
  return {
    status,
    key: tracked.key,
    ...(creation ? { creation } : {}),
    ...(search ? { search } : {}),
    ...(open ? { open } : {}),
    evidence,
    missing,
  };
}
