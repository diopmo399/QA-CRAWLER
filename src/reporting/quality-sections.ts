import type { ExplorationResult } from '../model/exploration-result.js';
import type { OracleStatus } from '../oracles/oracle.js';
import { esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/** Texts of the quality sections (oracles, forms, recovery, authorization, data). */
interface QualityTexts {
  oraclesTitle: string;
  oraclesHint: string;
  noVerdict: string;
  moreRows: (count: number) => string;
  formsTitle: string;
  formsHint: string;
  validationCases: string;
  recoveryTitle: string;
  recoveryHint: string;
  stuckTitle: string;
  circuitsTitle: string;
  reauthentications: (count: number) => string;
  authorizationTitle: string;
  authorizationHint: string;
  rulesTitle: string;
  differencesTitle: string;
  noDifference: string;
  dataTitle: string;
  dataHint: string;
  mutations: (executed: number, max: number | undefined, enabled: boolean) => string;
  noData: string;
  recovered: string;
  notRecovered: string;
  oracleFindings: string;
  accessibility: string;
  authorizationIssues: string;
  engineLog: string;
  columns: {
    state: string;
    action: string;
    verdict: string;
    confidence: string;
    assertions: string;
    field: string;
    type: string;
    required: string;
    filled: string;
    source: string;
    case: string;
    outcome: string;
    message: string;
    strategy: string;
    failure: string;
    result: string;
    kind: string;
    occurrences: string;
    actor: string;
    path: string;
    expected: string;
    checked: string;
    screen: string;
    access: string;
    tag: string;
    requests: string;
  };
}

const EN: QualityTexts = {
  oraclesTitle: 'Test oracle verdicts',
  oraclesHint:
    'Each executed action judged by the technical, UI, baseline and contract oracles. UNKNOWN is never counted as PASS: without a business expectation, the business result stays unknown.',
  noVerdict: 'No action judged.',
  moreRows: (count) => `… and ${count} more (see result.json).`,
  formsTitle: 'Forms discovered',
  formsHint: 'Fields found, what was typed (never a sensitive value) and what the application answered.',
  validationCases: 'Validation cases',
  recoveryTitle: 'Recovery',
  recoveryHint: 'How the exploration came back after a failure, and the branches it left.',
  stuckTitle: 'Abandoned branches',
  circuitsTitle: 'Failures not tried again',
  reauthentications: (count) => `${count} re-authentication(s) after a session expiry.`,
  authorizationTitle: 'Authorization',
  authorizationHint:
    'Each actor opened the screens found (page loads only, no action). A difference is an observation; only a rule makes it PASS or FAIL.',
  rulesTitle: 'Rules',
  differencesTitle: 'Access differences',
  noDifference: 'Every actor reaches the same screens.',
  dataTitle: 'Data created',
  dataHint: 'Actions that changed data, tagged with the run. Nothing is deleted automatically.',
  mutations: (executed, max, enabled) =>
    enabled
      ? `${executed} action(s) changing data executed (budget: ${max ?? '∞'}).`
      : 'Actions changing data are disabled (safety.mutations.enabled: false).',
  noData: 'No data created.',
  recovered: 'recovered',
  notRecovered: 'failed',
  oracleFindings: 'Oracle findings (screen, baseline, API contract)',
  accessibility: 'Accessibility',
  authorizationIssues: 'Authorization rules failed',
  engineLog: 'engine log',
  columns: {
    state: 'State',
    action: 'Action',
    verdict: 'Verdict',
    confidence: 'Confidence',
    assertions: 'Observed assertions',
    field: 'Field',
    type: 'Type',
    required: 'Required',
    filled: 'Filled',
    source: 'Source',
    case: 'Case',
    outcome: 'Outcome',
    message: 'Message',
    strategy: 'Strategy',
    failure: 'Failure',
    result: 'Result',
    kind: 'Kind',
    occurrences: 'Occurrences',
    actor: 'Actor',
    path: 'Path',
    expected: 'Expected',
    checked: 'Checked',
    screen: 'Screen',
    access: 'Access',
    tag: 'Tag',
    requests: 'Requests',
  },
};

const FR: QualityTexts = {
  oraclesTitle: 'Verdicts des oracles de test',
  oraclesHint:
    'Chaque action exécutée jugée par les oracles technique, écran, baseline et contrat. UNKNOWN n’est jamais compté comme PASS : sans attente métier, le résultat métier reste inconnu.',
  noVerdict: 'Aucune action jugée.',
  moreRows: (count) => `… et ${count} de plus (voir result.json).`,
  formsTitle: 'Formulaires découverts',
  formsHint:
    'Champs trouvés, ce qui a été saisi (jamais une valeur sensible) et la réponse de l’application.',
  validationCases: 'Cas de validation',
  recoveryTitle: 'Récupération',
  recoveryHint: 'Comment l’exploration est revenue après un échec, et les branches abandonnées.',
  stuckTitle: 'Branches abandonnées',
  circuitsTitle: 'Échecs non retentés',
  reauthentications: (count) => `${count} reconnexion(s) après expiration de session.`,
  authorizationTitle: 'Autorisations',
  authorizationHint:
    'Chaque acteur a ouvert les écrans trouvés (chargements de page seulement, aucune action). Une différence est une observation ; seule une règle la rend PASS ou FAIL.',
  rulesTitle: 'Règles',
  differencesTitle: 'Différences d’accès',
  noDifference: 'Tous les acteurs atteignent les mêmes écrans.',
  dataTitle: 'Données créées',
  dataHint:
    'Actions ayant modifié des données, marquées avec l’identifiant du run. Rien n’est supprimé automatiquement.',
  mutations: (executed, max, enabled) =>
    enabled
      ? `${executed} action(s) de modification exécutée(s) (budget : ${max ?? '∞'}).`
      : 'Les actions de modification sont désactivées (safety.mutations.enabled: false).',
  noData: 'Aucune donnée créée.',
  recovered: 'récupéré',
  notRecovered: 'échec',
  oracleFindings: 'Constats des oracles (écran, baseline, contrat API)',
  accessibility: 'Accessibilité',
  authorizationIssues: 'Règles d’autorisation en échec',
  engineLog: 'journal moteur',
  columns: {
    state: 'État',
    action: 'Action',
    verdict: 'Verdict',
    confidence: 'Confiance',
    assertions: 'Assertions observées',
    field: 'Champ',
    type: 'Type',
    required: 'Requis',
    filled: 'Saisie',
    source: 'Source',
    case: 'Cas',
    outcome: 'Résultat',
    message: 'Message',
    strategy: 'Stratégie',
    failure: 'Échec',
    result: 'Résultat',
    kind: 'Nature',
    occurrences: 'Occurrences',
    actor: 'Acteur',
    path: 'Chemin',
    expected: 'Attendu',
    checked: 'Vérifiés',
    screen: 'Écran',
    access: 'Accès',
    tag: 'Marqueur',
    requests: 'Requêtes',
  },
};

const STATUS_COLORS: Record<OracleStatus, string> = {
  FAIL: '#c62828',
  WARNING: '#ef6c00',
  UNKNOWN: '#757575',
  PASS: '#2e7d32',
};
const ORDER: OracleStatus[] = ['FAIL', 'WARNING', 'UNKNOWN', 'PASS'];
const MAX_ROWS = 150;

const pill = (status: string, color: string): string =>
  `<span class="pill" style="background:${color};color:#fff">${esc(status)}</span>`;
const statusPill = (status: OracleStatus): string => pill(status, STATUS_COLORS[status]);
const table = (headers: string[], rows: string[]): string =>
  `<table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

export function qualityTexts(language: ReportLanguage): QualityTexts {
  return language === 'fr' ? FR : EN;
}

/** Verdicts of the test oracles, the most worrying first. */
export function oraclesSection(
  result: ExplorationResult,
  nameOf: (stateId: string) => string,
  language: ReportLanguage,
): string {
  const t = qualityTexts(language);
  const judged = result.transitions.filter((edge) => edge.oracle);
  if (judged.length === 0) return '';
  const counts = Object.fromEntries(ORDER.map((status) => [status, 0])) as Record<OracleStatus, number>;
  for (const edge of judged) if (edge.oracle) counts[edge.oracle.status] += 1;
  const sorted = [...judged].sort(
    (a, b) => ORDER.indexOf(a.oracle?.status ?? 'PASS') - ORDER.indexOf(b.oracle?.status ?? 'PASS'),
  );
  const rows = sorted.slice(0, MAX_ROWS).map((edge) => {
    const verdict = edge.oracle;
    if (!verdict) return '';
    return `<tr><td>${esc(nameOf(edge.from))}</td><td class="wrap">${esc(edge.action.type)} “${esc(edge.action.text ?? edge.action.label ?? '')}”</td><td>${statusPill(verdict.status)}</td><td>${Math.round(verdict.confidence * 100)} %</td><td class="wrap">${verdict.assertions.map((line) => esc(line)).join('<br>')}</td></tr>`;
  });
  const c = t.columns;
  return `<section><h2>${esc(t.oraclesTitle)} (${judged.length})</h2>
    <p class="muted">${esc(t.oraclesHint)}</p>
    <p>${ORDER.map((status) => `${statusPill(status)} ${counts[status]}`).join(' &nbsp; ')}</p>
    ${table([c.state, c.action, c.verdict, c.confidence, c.assertions], rows)}
    ${sorted.length > MAX_ROWS ? `<p class="muted">${esc(t.moreRows(sorted.length - MAX_ROWS))}</p>` : ''}
  </section>`;
}

/** Forms found, how they were filled, what the validation said. */
export function formsSection(
  result: ExplorationResult,
  nameOf: (stateId: string) => string,
  language: ReportLanguage,
): string {
  const forms = result.formReports ?? [];
  if (forms.length === 0) return '';
  const t = qualityTexts(language);
  const c = t.columns;
  const blocks = forms.map((form) => {
    const fields = form.fields.map(
      (field) =>
        `<tr><td class="wrap">${esc(field.label)}${field.sensitive ? ' 🔒' : ''}</td><td>${esc(field.type)}</td><td>${field.required ? '✓' : ''}</td><td class="wrap">${esc(field.filled)}${field.error ? `<br><span class="muted">${esc(field.error)}</span>` : ''}</td><td>${esc(field.source ?? '')}</td></tr>`,
    );
    const problems = form.validationProblems.map(
      (problem) => `<li>${esc(problem.field)} : ${esc(problem.message)}</li>`,
    );
    const cases = form.validationCases.map(
      (entry) =>
        `<tr><td>${esc(entry.field)}</td><td>${esc(entry.case)}</td><td>${esc(entry.outcome)}</td><td>${statusPill(entry.verdict)}</td><td class="wrap">${esc(entry.message ?? '')}</td></tr>`,
    );
    return `<h3>${esc(form.name)} <span class="muted">— ${esc(nameOf(form.stateId))}</span></h3>
      ${table([c.field, c.type, c.required, c.filled, c.source], fields)}
      ${problems.length > 0 ? `<ul>${problems.join('')}</ul>` : ''}
      ${cases.length > 0 ? `<h4>${esc(t.validationCases)}</h4>${table([c.field, c.case, c.outcome, c.verdict, c.message], cases)}` : ''}`;
  });
  return `<section><h2>${esc(t.formsTitle)} (${forms.length})</h2><p class="muted">${esc(t.formsHint)}</p>${blocks.join('')}</section>`;
}

/** Recovery attempts, abandoned branches, circuits open. */
export function recoverySection(
  result: ExplorationResult,
  nameOf: (stateId: string) => string,
  language: ReportLanguage,
): string {
  const recovery = result.recovery;
  if (!recovery) return '';
  const { events, stuck, circuits, reauthentications } = recovery;
  if (events.length + stuck.length + circuits.length + reauthentications === 0) return '';
  const t = qualityTexts(language);
  const c = t.columns;
  const rows = events
    .slice(0, MAX_ROWS)
    .map(
      (event) =>
        `<tr><td>${esc(nameOf(event.stateId))}</td><td>${esc(event.failure)}${event.message ? `<br><span class="muted">${esc(event.message)}</span>` : ''}</td><td>${esc(event.strategy)}</td><td>${event.success ? pill(t.recovered, STATUS_COLORS.PASS) : pill(t.notRecovered, STATUS_COLORS.WARNING)}</td></tr>`,
    );
  return `<section><h2>${esc(t.recoveryTitle)} (${events.length})</h2>
    <p class="muted">${esc(t.recoveryHint)}</p>
    ${reauthentications > 0 ? `<p>${esc(t.reauthentications(reauthentications))}</p>` : ''}
    ${rows.length > 0 ? table([c.state, c.failure, c.strategy, c.result], rows) : ''}
    ${
      stuck.length > 0
        ? `<h3>${esc(t.stuckTitle)} (${stuck.length})</h3>${table(
            [c.state, c.kind, c.message],
            stuck.map(
              (event) =>
                `<tr><td>${esc(nameOf(event.stateId))}</td><td>${esc(event.kind)}</td><td class="wrap">${esc(event.message)}</td></tr>`,
            ),
          )}`
        : ''
    }
    ${
      circuits.length > 0
        ? `<h3>${esc(t.circuitsTitle)} (${circuits.length})</h3>${table(
            [c.state, c.action, c.failure, c.occurrences],
            circuits.map(
              (circuit) =>
                `<tr><td>${esc(nameOf(circuit.stateId))}</td><td>${esc(circuit.actionId ?? '—')}</td><td class="wrap">${esc(circuit.failure)}</td><td>${circuit.occurrences}</td></tr>`,
            ),
          )}`
        : ''
    }
  </section>`;
}

/** What each actor reaches, the differences, the rules. */
export function authorizationSection(result: ExplorationResult, language: ReportLanguage): string {
  const report = result.authorization;
  if (!report) return '';
  const t = qualityTexts(language);
  const c = t.columns;
  const rules = report.rules.map(
    (rule) =>
      `<tr><td>${esc(rule.actor)}</td><td>${esc(rule.path)}</td><td>${esc(rule.expect)}</td><td>${statusPill(rule.status)}</td><td>${rule.checked}</td><td class="wrap">${rule.violations.map((violation) => esc(violation)).join('<br>')}</td></tr>`,
  );
  const differences = report.differences.map(
    (difference) =>
      `<tr><td class="wrap">${esc(difference.label)}<br><span class="muted">${esc(difference.url)}</span></td>${report.actors
        .map((actor) => `<td>${esc(difference.access[actor] ?? '—')}</td>`)
        .join('')}</tr>`,
  );
  return `<section><h2>${esc(t.authorizationTitle)} — ${esc(report.actors.join(', '))}</h2>
    <p class="muted">${esc(t.authorizationHint)}</p>
    ${report.errors.map((error) => `<p>⚠ ${esc(error.actor)} : ${esc(error.message)}</p>`).join('')}
    ${rules.length > 0 ? `<h3>${esc(t.rulesTitle)}</h3>${table([c.actor, c.path, c.expected, c.verdict, c.checked, c.message], rules)}` : ''}
    <h3>${esc(t.differencesTitle)} (${differences.length})</h3>
    ${differences.length > 0 ? table([c.screen, ...report.actors], differences) : `<p class="empty">${esc(t.noDifference)}</p>`}
  </section>`;
}

/** Mutation budget, data created, what is left to clean up. */
export function dataSection(
  result: ExplorationResult,
  nameOf: (stateId: string) => string,
  language: ReportLanguage,
): string {
  const mutations = result.mutations;
  if (!mutations) return '';
  const created = result.createdData ?? [];
  if (!mutations.enabled && created.length === 0) return '';
  const t = qualityTexts(language);
  const c = t.columns;
  const rows = created.map(
    (record) =>
      `<tr><td>${esc(nameOf(record.stateId))}</td><td>${esc(record.action)}</td><td>${esc(record.tag)}</td><td class="wrap">${record.requests.map((request) => `${esc(request.method)} ${esc(request.url)} → ${request.status}`).join('<br>')}</td></tr>`,
  );
  return `<section><h2>${esc(t.dataTitle)} (${created.length})</h2>
    <p class="muted">${esc(t.dataHint)}</p>
    <p>${esc(t.mutations(mutations.executed, mutations.maxPerRun, mutations.enabled))}</p>
    ${rows.length > 0 ? table([c.state, c.action, c.tag, c.requests], rows) : `<p class="empty">${esc(t.noData)}</p>`}
    ${(result.cleanup?.notes ?? []).map((note) => `<p>${esc(note)}</p>`).join('')}
  </section>`;
}
