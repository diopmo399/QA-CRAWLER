import type { FlowRunReport, FlowStepReport } from '../model/flow-run.js';
import { classPill, esc, formatDate } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/**
 * ANALYSE D'UN FLOW EXÉCUTÉ, par flow imposé, sous son tableau d'étapes :
 *   1. les données de test de ce run (valeur générée, où elle est produite, où elle est réutilisée) ;
 *   2. la preuve métier (CREATE → SEARCH → OPEN confirmé à l'exécution, avec les preuves) ;
 *   3. le réseau par étape (méthode, chemin, statut, durée) ;
 *   4. la résolution des cibles (demandée, utilisée, comment, verdict) ;
 *   5. les effets attendus / observés / manquants ;
 *   6. le temps par étape (action, transition, stabilité, vérification) et les plus lentes ;
 *   7. l'écart avec le run précédent.
 * Tout vient du rapport du flow : rien n'est recalculé contre l'application, aucune valeur sensible.
 */
const TEXTS = {
  en: {
    testData: 'Test data of this run',
    testDataHint:
      'One value per key for the whole run. A value is shown only when the crawler generated it (synthetic, run-tagged): never a recorded, mission or secret value.',
    key: 'Key',
    strategy: 'Strategy',
    value: 'Value of this run',
    producedAt: 'Produced at',
    usedBy: 'Used by',
    notShown: '(not shown)',
    secret: '(secret)',
    stepN: (index: number) => `step ${String(index)}`,
    input: 'input',
    citation: 'cited',
    proof: 'Business proof',
    proofHint:
      'Did the flow prove its goal? The created datum must be sent again as a search criterion, then the result carrying it opened — read from the steps, their data and their requests.',
    proofStatus: {
      PROVEN: 'The created datum was searched and opened in this run.',
      PARTIAL: 'Only part of CREATE → SEARCH → OPEN was observed.',
      NOT_PROVEN: 'A stage ran but did not pass.',
      NOT_APPLICABLE: 'No test datum is reused by a later step: nothing to prove.',
    } as Record<string, string>,
    stages: { creation: 'CREATE', search: 'SEARCH', open: 'OPEN' },
    evidence: 'Evidence',
    missing: 'Missing',
    network: 'Network per step',
    networkHint: 'The requests each step triggered (masked path, never a body nor a header).',
    request: 'Request',
    status: 'Status',
    duration: 'Duration',
    type: 'Type',
    totals: (requests: number, writes: number, errors: number) =>
      `${String(requests)} request(s) · ${String(writes)} write(s) · ${String(errors)} error(s)`,
    targets: 'Target resolution',
    targetsHint:
      'How each target was found: the recorded locator, a healed one, a functional or contextual match.',
    requested: 'Requested',
    used: 'Used',
    how: 'How',
    verdict: 'Verdict',
    effects: 'Effects expected / observed',
    effectsHint: 'What each recorded step expected after the action, what was observed, and what never came.',
    expected: 'Expected',
    observed: 'Observed',
    notObserved: 'Not observed',
    timing: 'Time per step',
    timingHint:
      'Where the time went: the gesture itself, the transition wait (inside the gesture when the probe is set), the stability wait, then observation and verification.',
    total: 'Total',
    action: 'Action',
    transition: 'Transition',
    stability: 'Stability',
    verification: 'Verification',
    slowest: 'Slowest steps',
    comparison: 'Compared with the previous run',
    comparisonHint:
      'The previous run of this flow (knowledge base): status, duration and target drift. History suggests, it is never an anomaly by itself.',
    previous: (runId: string, at: string, status: string) => `previous run ${runId} (${at}) · ${status}`,
    same: 'No notable change since the previous run.',
    faster: (ms: number) => `${String(ms)} ms faster`,
    slower: (ms: number) => `${String(ms)} ms slower`,
  },
  fr: {
    testData: 'Données de test de ce run',
    testDataHint:
      'Une valeur par clé pour tout le run. Une valeur n’est montrée que si le crawler l’a générée (synthétique, marquée du run) : jamais une valeur enregistrée, de la mission ou un secret.',
    key: 'Clé',
    strategy: 'Stratégie',
    value: 'Valeur de ce run',
    producedAt: 'Produite à',
    usedBy: 'Utilisée par',
    notShown: '(non montrée)',
    secret: '(secret)',
    stepN: (index: number) => `étape ${String(index)}`,
    input: 'saisie',
    citation: 'citée',
    proof: 'Preuve métier',
    proofHint:
      'Le flow a-t-il prouvé son objectif ? La donnée créée doit être renvoyée comme critère de recherche, puis le résultat qui la porte ouvert — lu dans les étapes, leurs données et leurs requêtes.',
    proofStatus: {
      PROVEN: 'La donnée créée a été recherchée puis ouverte dans ce run.',
      PARTIAL: 'Seule une partie de CREATE → SEARCH → OPEN a été observée.',
      NOT_PROVEN: 'Une étape a été exécutée sans réussir.',
      NOT_APPLICABLE: 'Aucune donnée de test n’est réutilisée par une étape suivante : rien à prouver.',
    } as Record<string, string>,
    stages: { creation: 'CREATE', search: 'SEARCH', open: 'OPEN' },
    evidence: 'Preuves',
    missing: 'Manque',
    network: 'Réseau par étape',
    networkHint: 'Les requêtes déclenchées par chaque étape (chemin masqué, jamais un corps ni un en-tête).',
    request: 'Requête',
    status: 'Statut',
    duration: 'Durée',
    type: 'Type',
    totals: (requests: number, writes: number, errors: number) =>
      `${String(requests)} requête(s) · ${String(writes)} écriture(s) · ${String(errors)} erreur(s)`,
    targets: 'Résolution des cibles',
    targetsHint:
      'Comment chaque cible a été trouvée : le localisateur enregistré, un localisateur réparé, une correspondance fonctionnelle ou contextuelle.',
    requested: 'Demandée',
    used: 'Utilisée',
    how: 'Comment',
    verdict: 'Verdict',
    effects: 'Effets attendus / observés',
    effectsHint:
      'Ce que chaque étape enregistrée attendait après l’action, ce qui a été observé, et ce qui n’est jamais venu.',
    expected: 'Attendu',
    observed: 'Observé',
    notObserved: 'Non observé',
    timing: 'Temps par étape',
    timingHint:
      'Où le temps est passé : le geste lui-même, l’attente de la transition (dans le geste quand la sonde est posée), l’attente de stabilité, puis l’observation et la vérification.',
    total: 'Total',
    action: 'Action',
    transition: 'Transition',
    stability: 'Stabilité',
    verification: 'Vérification',
    slowest: 'Étapes les plus lentes',
    comparison: 'Écart avec le run précédent',
    comparisonHint:
      'Le run précédent de ce flow (base de connaissances) : statut, durée et dérive des cibles. L’historique suggère, ce n’est jamais une anomalie à lui seul.',
    previous: (runId: string, at: string, status: string) => `run précédent ${runId} (${at}) · ${status}`,
    same: 'Aucun changement notable depuis le run précédent.',
    faster: (ms: number) => `${String(ms)} ms plus rapide`,
    slower: (ms: number) => `${String(ms)} ms plus lent`,
  },
};

type Texts = (typeof TEXTS)['en'];

const ms = (value: number | undefined): string => (value === undefined ? '' : `${String(value)} ms`);

function block(title: string, hint: string, body: string, open = true): string {
  return `<details class="flow-analysis"${open ? ' open' : ''}><summary><b>${esc(title)}</b></summary><p class="muted">${esc(hint)}</p>${body}</details>`;
}

function table(headers: string[], rows: string[]): string {
  return `<table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function testDataBlock(flow: FlowRunReport, t: Texts): string {
  const entries = flow.testDataReport?.entries ?? [];
  if (entries.length === 0) return '';
  const rows = entries.map(
    (entry) =>
      `<tr><td><code>${esc(entry.key)}</code></td><td>${esc(entry.strategy)}${entry.generator ? ` (${esc(entry.generator)})` : ''}</td><td class="wrap">${entry.sensitive ? esc(t.secret) : entry.value !== undefined ? `<code>${esc(entry.value)}</code>` : `<span class="muted">${esc(t.notShown)}</span>`}</td><td>${entry.producedAt !== undefined ? esc(t.stepN(entry.producedAt)) : ''}</td><td class="wrap">${entry.usedBy.map((use) => `${esc(t.stepN(use.step))} <span class="muted">(${esc(use.how === 'INPUT' ? t.input : t.citation)})</span>`).join(', ')}</td></tr>`,
  );
  return block(t.testData, t.testDataHint, table([t.key, t.strategy, t.value, t.producedAt, t.usedBy], rows));
}

function proofBlock(flow: FlowRunReport, t: Texts): string {
  const proof = flow.businessProof;
  if (!proof || proof.status === 'NOT_APPLICABLE') return '';
  const stage = (name: string, value: typeof proof.creation): string =>
    value
      ? `<li><b>${esc(name)}</b> · ${esc(t.stepN(value.step))} ${classPill(value.status)} <code>${esc(value.description)}</code>${value.request ? ` → <code>${esc(value.request)}</code>` : ''}</li>`
      : `<li><b>${esc(name)}</b> · <span class="muted">—</span></li>`;
  const body = `<p>${classPill(proof.status)} ${esc(t.proofStatus[proof.status] ?? '')}${proof.key ? ` · <code>testData.${esc(proof.key)}</code>` : ''}</p>
    <ul>${stage(t.stages.creation, proof.creation)}${stage(t.stages.search, proof.search)}${stage(t.stages.open, proof.open)}</ul>
    ${proof.evidence.length > 0 ? `<p class="muted"><b>${esc(t.evidence)}</b></p><ul class="muted">${proof.evidence.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}
    ${proof.missing.length > 0 ? `<p class="muted"><b>${esc(t.missing)}</b></p><ul class="muted">${proof.missing.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}`;
  return block(t.proof, t.proofHint, body);
}

function networkBlock(flow: FlowRunReport, t: Texts): string {
  const steps = flow.steps.filter((step) => step.network && step.network.requests.length > 0);
  if (steps.length === 0) return '';
  const rows = steps.flatMap((step) =>
    (step.network?.requests ?? []).map(
      (request, position) =>
        `<tr><td>${position === 0 ? String(step.index) : ''}</td><td class="wrap">${position === 0 ? `<code>${esc(step.description)}</code>` : ''}</td><td class="wrap"><code>${esc(request.method)} ${esc(request.path)}</code></td><td>${request.failure ? `<span class="pill FAILED">${esc(request.failure)}</span>` : request.status !== undefined ? classPill(String(request.status)) : ''}</td><td>${ms(request.durationMs)}</td><td class="muted">${esc(request.resourceType)}</td></tr>`,
    ),
  );
  const totals = steps.reduce(
    (sum, step) => ({
      requests: sum.requests + (step.network?.requests.length ?? 0),
      writes: sum.writes + (step.network?.writes ?? 0),
      errors: sum.errors + (step.network?.errors ?? 0),
    }),
    { requests: 0, writes: 0, errors: 0 },
  );
  return block(
    t.network,
    t.networkHint,
    `<p class="muted">${esc(t.totals(totals.requests, totals.writes, totals.errors))}</p>${table(['#', '', t.request, t.status, t.duration, t.type], rows)}`,
    false,
  );
}

/** Comment la cible a été trouvée, d'après ce que l'étape a rapporté. */
export function targetHowOf(step: FlowStepReport): string | undefined {
  if (step.targetResolution) {
    const trace = step.targetResolution;
    if (trace.status === 'TARGET_HEALED') return 'HEALED';
    if (trace.outcome === 'CONTEXTUAL_MATCH') return 'CONTEXTUAL';
    if (trace.rerender.detected) return 'RERENDERED';
    return trace.status === 'TARGET_FUNCTIONALLY_EQUIVALENT' ? 'FUNCTIONAL' : trace.status;
  }
  if (step.effect?.healed) return 'HEALED';
  if (step.synchronization?.reacquired) return 'REACQUIRED';
  if (step.resolution) return `SEMANTIC ${step.resolution.status}`;
  if (step.cssResolution) return step.cssResolution.resolution;
  if (step.effect?.locator) return 'RECORDED';
  return undefined;
}

function targetsBlock(flow: FlowRunReport, t: Texts): string {
  const steps = flow.steps.filter((step) => targetHowOf(step) !== undefined);
  if (steps.length === 0) return '';
  const rows = steps.map((step) => {
    const used = step.effect?.healed?.to ?? step.effect?.locator ?? step.resolution?.selected ?? '';
    const verdict = [
      step.effect?.targetMatch
        ? `${step.effect.targetMatch.verdict} ${String(step.effect.targetMatch.score)}`
        : '',
      step.cssResolution
        ? `${step.cssResolution.resolution} (${String(step.cssResolution.currentMatches)})`
        : '',
      step.targetResolution?.runtimeVerification
        ? `runtime ${step.targetResolution.runtimeVerification.status}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<tr><td>${String(step.index)}</td><td class="wrap"><code>${esc(step.description)}</code></td><td class="wrap"><code>${esc(used)}</code></td><td>${classPill(targetHowOf(step) ?? '')}</td><td class="wrap muted">${esc(verdict)}</td></tr>`;
  });
  return block(t.targets, t.targetsHint, table(['#', t.requested, t.used, t.how, t.verdict], rows), false);
}

function effectsBlock(flow: FlowRunReport, t: Texts): string {
  const steps = flow.steps.filter(
    (step) => step.effect && (step.effect.expected.length > 0 || step.effect.observed.length > 0),
  );
  if (steps.length === 0) return '';
  const rows = steps.map((step) => {
    const effect = step.effect;
    const observed = new Set(effect?.observed ?? []);
    const missing = [
      ...(effect?.expected ?? []).filter((expected) => !observed.has(expected)),
      ...(step.synchronization?.missing ?? []),
    ];
    return `<tr><td>${String(step.index)}</td><td class="wrap"><code>${esc(step.description)}</code></td><td>${classPill(effect?.status ?? '')}</td><td class="wrap">${(effect?.expected ?? []).map(esc).join('<br>')}</td><td class="wrap">${(effect?.observed ?? []).map(esc).join('<br>')}</td><td class="wrap">${missing.length > 0 ? `<span class="pill FAILED">${esc(t.notObserved)}</span><br>${missing.map(esc).join('<br>')}` : ''}</td></tr>`;
  });
  return block(
    t.effects,
    t.effectsHint,
    table(['#', '', t.status, t.expected, t.observed, t.notObserved], rows),
    false,
  );
}

function timingBlock(flow: FlowRunReport, t: Texts): string {
  const steps = flow.steps.filter((step) => step.timing);
  if (steps.length === 0) return '';
  const longest = Math.max(1, ...steps.map((step) => step.timing?.totalMs ?? 0));
  const rows = steps.map((step) => {
    const timing = step.timing;
    const width = Math.round(((timing?.totalMs ?? 0) / longest) * 100);
    return `<tr><td>${String(step.index)}</td><td class="wrap"><code>${esc(step.description)}</code><div class="timebar"><span style="width:${String(width)}%"></span></div></td><td>${ms(timing?.totalMs)}</td><td>${ms(timing?.actionMs)}</td><td>${ms(timing?.transitionMs)}</td><td>${ms(timing?.stabilityMs)}</td><td>${ms(timing?.verificationMs)}</td></tr>`;
  });
  const slowest = [...steps]
    .sort((a, b) => (b.timing?.totalMs ?? 0) - (a.timing?.totalMs ?? 0))
    .slice(0, 3)
    .map((step) => `${t.stepN(step.index)} (${ms(step.timing?.totalMs)})`);
  return block(
    t.timing,
    t.timingHint,
    `${table(['#', '', t.total, t.action, t.transition, t.stability, t.verification], rows)}<p class="muted"><b>${esc(t.slowest)}</b> : ${esc(slowest.join(' · '))}</p>`,
    false,
  );
}

function comparisonBlock(flow: FlowRunReport, t: Texts): string {
  const comparison = flow.comparison;
  if (!comparison) return '';
  const delta = comparison.durationDeltaMs;
  const pace = delta < 0 ? t.faster(-delta) : delta > 0 ? t.slower(delta) : '';
  const body = `<p>${classPill(comparison.verdict)} ${esc(t.previous(comparison.previous.runId, formatDate(comparison.previous.at), comparison.previous.status))}${pace ? ` · ${esc(pace)}` : ''}</p>
    ${
      comparison.changes.length === 0
        ? `<p class="muted">${esc(t.same)}</p>`
        : `<ul>${comparison.changes.map((change) => `<li>${classPill(change.kind)} ${change.step !== undefined ? esc(t.stepN(change.step)) : ''} <span class="muted">${esc(change.detail)}</span></li>`).join('')}</ul>`
    }`;
  return block(t.comparison, t.comparisonHint, body);
}

export function flowAnalysisBlocks(flow: FlowRunReport, language: ReportLanguage): string {
  const t = TEXTS[language];
  return [
    testDataBlock(flow, t),
    proofBlock(flow, t),
    comparisonBlock(flow, t),
    networkBlock(flow, t),
    targetsBlock(flow, t),
    effectsBlock(flow, t),
    timingBlock(flow, t),
  ].join('');
}
