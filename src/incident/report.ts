import { redactText } from '../security/redactor.js';
import { incidentReproduction } from './evidence.js';
import { REPORT_SECTIONS } from './model.js';
import type {
  AiInvestigationRun,
  CodeSymbol,
  GraphEdge,
  HttpExchange,
  Incident,
  IncidentAccess,
  InvestigationGraph,
  InvestigationMemory,
  InvestigationReport,
  InvestigationReportPart,
  ReportSection,
  ReproductionRun,
} from './model.js';

/**
 * LE RAPPORT D'INVESTIGATION : structuré (JSON) et lisible (Markdown). Il dit ce qui a été observé,
 * ce qui a été lu dans le code, ce qui a été vérifié, et ce qu'il ne peut pas affirmer.
 */

type TimelineEntry = InvestigationReport['timeline'][number];

const KIND_RANK: Record<string, number> = { ACTION: 0, REQUEST: 1 };

function timelineOf(reproduction: ReproductionRun): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const action of reproduction.actions)
    entries.push({
      ...(action.startedAt ? { at: action.startedAt } : {}),
      step: action.index,
      kind: 'ACTION',
      summary: redactText(
        `${action.description} : ${action.status}${action.reason ? ` (${action.reason})` : ''}`,
      ),
      ref: `${reproduction.id}:ev-action-${String(action.index)}`,
    });
  for (const request of reproduction.requests)
    entries.push({
      ...(request.startedAt ? { at: request.startedAt } : {}),
      ...(request.step !== undefined ? { step: request.step } : {}),
      kind: 'REQUEST',
      summary: `${request.method} ${request.path} → ${request.status !== undefined ? String(request.status) : (request.failure ?? 'sans réponse')} [${request.correlation}]`,
      ref: request.id,
    });
  // Les actions ont déjà leur ligne : leurs preuves ACTION ne sont pas répétées.
  for (const item of reproduction.evidence.filter((evidence) => evidence.kind !== 'ACTION'))
    entries.push({
      ...(item.at ? { at: item.at } : {}),
      ...(item.source.step !== undefined ? { step: item.source.step } : {}),
      kind: item.kind,
      summary: redactText(item.summary),
      ref: item.id,
    });

  // Ordre : l'heure quand elle est connue, sinon celle de l'étape ; puis l'étape, la sorte, l'ordre d'origine.
  const stepTime = new Map(
    reproduction.actions.map((action) => [
      action.index,
      action.startedAt ? Date.parse(action.startedAt) : Number.NaN,
    ]),
  );
  const keyed = entries.map((entry, index) => {
    const own = entry.at ? Date.parse(entry.at) : Number.NaN;
    const time =
      Number.isNaN(own) && entry.step !== undefined ? (stepTime.get(entry.step) ?? Number.NaN) : own;
    return { entry, index, time: Number.isNaN(time) ? Number.POSITIVE_INFINITY : time };
  });
  keyed.sort(
    (left, right) =>
      left.time - right.time ||
      (left.entry.step ?? Number.MAX_SAFE_INTEGER) - (right.entry.step ?? Number.MAX_SAFE_INTEGER) ||
      (KIND_RANK[left.entry.kind] ?? 2) - (KIND_RANK[right.entry.kind] ?? 2) ||
      left.index - right.index,
  );
  return keyed.map((item) => item.entry);
}

function limitationsOf(incident: Incident, reproduction: ReproductionRun | undefined): string[] {
  const { investigation } = incident;
  const limitations: string[] = [];
  if (!reproduction) limitations.push('Aucune reproduction : la chronologie et les requêtes sont vides.');
  else {
    if (reproduction.reproduced === false)
      limitations.push(
        `Le symptôme n'a pas été reproduit (${reproduction.symptomMatch ?? 'aucune correspondance'}).`,
      );
    if (reproduction.reproduced === null || reproduction.status !== 'COMPLETED')
      limitations.push(
        `La dernière reproduction n'a pas abouti (${reproduction.status}${reproduction.error ? ` : ${reproduction.error}` : ''}).`,
      );
    const errors = reproduction.requests.filter((request) => (request.status ?? 0) >= 400);
    if (errors.length > 0 && errors.every((request) => request.responseBody === undefined))
      limitations.push(
        "Les corps des réponses en erreur n'ont pas été capturés (network.captureBodies désactivé) : le message du serveur n'est pas connu.",
      );
    if (reproduction.requests.some((request) => request.correlation !== 'OBSERVED'))
      limitations.push(
        "Certaines requêtes ne sont rattachées à une étape que par l'horodatage (INFERRED) ou pas du tout (UNKNOWN).",
      );
    if (!reproduction.trace)
      limitations.push('Pas de trace Playwright pour cette reproduction (browser.playwrightTrace).');
  }
  const aiUnproven = investigation.hypotheses.filter(
    (hypothesis) =>
      hypothesis.origin === 'AI' && hypothesis.status !== 'CONFIRMED' && hypothesis.status !== 'REFUTED',
  ).length;
  if (aiUnproven > 0)
    limitations.push(
      `${String(aiUnproven)} hypothèse(s) d'origine IA non éprouvée(s) : des propositions, jamais un diagnostic.`,
    );
  const lastRun = investigation.ai?.runs.at(-1);
  if (lastRun && lastRun.status !== 'DONE')
    limitations.push(
      `Le dernier run IA s'est terminé ${lastRun.status}${lastRun.stopReason ? ` (${lastRun.stopReason})` : ''} : ses conclusions sont partielles.`,
    );
  if (!investigation.code) limitations.push("Le code n'a pas été analysé.");
  else {
    if (investigation.code.truncated.length > 0)
      limitations.push(`Analyse du code partielle : ${investigation.code.truncated.join(' ; ')}.`);
    if (investigation.code.denied.length > 0)
      limitations.push(
        `${String(investigation.code.denied.length)} chemin(s) refusé(s) par le périmètre n'ont pas été lus.`,
      );
  }
  const graph = investigation.graph;
  if (!graph) limitations.push("Le graphe d'investigation n'a pas été construit.");
  else {
    const staticEdges = graph.edges.filter(
      (edge) => edge.status === 'STATICALLY_RESOLVED' || edge.status === 'INFERRED',
    ).length;
    if (staticEdges > 0)
      limitations.push(
        `${String(staticEdges)} relation(s) du graphe sont lues ou déduites du code (STATICALLY_RESOLVED / INFERRED) : ce ne sont pas des traces d'exécution.`,
      );
    const unknown = graph.edges.filter((edge) => edge.status === 'UNKNOWN').length;
    if (unknown > 0)
      limitations.push(`${String(unknown)} relation(s) du graphe restent inconnues (UNKNOWN).`);
  }
  if (investigation.hypotheses.length === 0) limitations.push('Aucune hypothèse proposée.');
  const done = investigation.experiments.filter((experiment) => experiment.status === 'DONE');
  if (done.length === 0)
    limitations.push("Aucune vérification n'a été exécutée : les hypothèses ne sont pas éprouvées.");
  const refused = investigation.experiments.filter((experiment) => experiment.status === 'REFUSED');
  if (refused.length > 0)
    limitations.push(`${String(refused.length)} vérification(s) refusée(s) par le périmètre.`);
  if (!investigation.diagnosis) limitations.push("Aucun diagnostic n'a été établi.");
  else if (investigation.diagnosis.status !== 'CONFIRMED')
    limitations.push(`Diagnostic ${investigation.diagnosis.status} : la cause racine n'est pas confirmée.`);
  if (investigation.regression && !investigation.regression.execution)
    limitations.push("Le test de non-régression proposé n'a pas encore été exécuté.");
  return limitations;
}

function redactRequest(request: HttpExchange): HttpExchange {
  return {
    ...request,
    url: redactText(request.url),
    ...(request.requestBody !== undefined ? { requestBody: redactText(request.requestBody) } : {}),
    ...(request.responseBody !== undefined ? { responseBody: redactText(request.responseBody) } : {}),
  };
}

export function buildReport(
  incident: Incident,
  now: Date,
  extra: { memory?: InvestigationMemory } = {},
): InvestigationReport {
  const { investigation } = incident;
  const reproduction = incidentReproduction(incident);
  const graph = investigation.graph;
  const code = investigation.code;
  const graphSymbols = new Set(
    (graph?.nodes ?? []).map((node) => node.symbolId).filter((id) => id !== undefined),
  );
  const symbols: CodeSymbol[] = (code?.symbols ?? []).filter((symbol) => graphSymbols.has(symbol.id));
  const files = [
    ...new Set([
      ...(graph?.nodes ?? []).map((node) => node.file).filter((file): file is string => file !== undefined),
      ...symbols.map((symbol) => symbol.file),
    ]),
  ].sort();
  return {
    version: 1,
    generatedAt: now.toISOString(),
    incident: {
      id: incident.id,
      projectId: incident.projectId,
      title: redactText(incident.title),
      description: redactText(incident.description),
      observed: redactText(incident.observed),
      expected: redactText(incident.expected),
      severity: incident.severity,
      state: incident.state,
    },
    environment: {
      execution: incident.execution,
      ...(incident.environmentId ? { environmentId: incident.environmentId } : {}),
      ...(reproduction?.baseUrl ? { baseUrl: reproduction.baseUrl } : {}),
    },
    scope: incident.scope,
    ...(incident.scenario ? { scenario: incident.scenario } : {}),
    ...(incident.access ? { access: incident.access } : {}),
    timeline: reproduction ? timelineOf(reproduction) : [],
    requests: (reproduction?.requests ?? []).map(redactRequest),
    code: { files, symbols, denied: code?.denied ?? [], truncated: code?.truncated ?? [] },
    ...(graph ? { graph } : {}),
    hypotheses: investigation.hypotheses,
    experiments: investigation.experiments,
    ...(investigation.diagnosis ? { diagnosis: investigation.diagnosis } : {}),
    ...(investigation.regression ? { regression: investigation.regression } : {}),
    ...(investigation.ai ? { ai: investigation.ai } : {}),
    ...(extra.memory ? { aiMemory: extra.memory } : {}),
    limitations: limitationsOf(incident, reproduction),
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────

/** Texte en ligne : sur une ligne, caractères Markdown neutralisés. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/([\\`*_[\]<>|#])/g, '\\$1')
    .trim();
}

const cell = (text: string | number | undefined): string =>
  text === undefined || text === '' ? '—' : escapeMarkdown(String(text));

function table(headers: string[], rows: (string | number | undefined)[][]): string[] {
  if (rows.length === 0) return ['_Aucun élément._'];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
}

/** Un bloc de code sans possibilité d'en sortir (les ``` du contenu sont neutralisés). */
function codeBlock(text: string, language = ''): string[] {
  return [`\`\`\`${language}`, text.replace(/```/g, '`​``'), '```'];
}

const MERMAID_ARROW: Record<GraphEdge['status'], string> = {
  OBSERVED: '==>',
  STATICALLY_RESOLVED: '-->',
  INFERRED: '-.->',
  UNKNOWN: '-.-x',
};

const mermaidLabel = (text: string): string =>
  text
    .replace(/["\n\r]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[[\]{}()|]/g, ' ')
    .slice(0, 80)
    .trim() || '?';

function mermaid(graph: InvestigationGraph): string[] {
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `n${String(index)}`]));
  const lines = ['flowchart LR'];
  for (const node of graph.nodes)
    lines.push(`  ${ids.get(node.id) ?? ''}["${mermaidLabel(`${node.kind} · ${node.label}`)}"]`);
  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from && to) lines.push(`  ${from} ${MERMAID_ARROW[edge.status]}|${edge.status}| ${to}`);
  }
  return codeBlock(lines.join('\n'), 'mermaid');
}

/**
 * Le rapport restreint à des sections : les clés des sections écartées sont retirées (jamais vidées).
 * L'en-tête de l'incident et les limites restent toujours.
 */
export function reportPart(
  report: InvestigationReport,
  sections: readonly ReportSection[],
): InvestigationReportPart {
  const keep = new Set(sections);
  const { description, observed, expected, ...header } = report.incident;
  return {
    version: report.version,
    generatedAt: report.generatedAt,
    sections: REPORT_SECTIONS.filter((section) => keep.has(section)),
    incident: keep.has('summary') ? { ...header, description, observed, expected } : header,
    ...(keep.has('summary') && report.scenario !== undefined ? { scenario: report.scenario } : {}),
    ...(keep.has('environment') ? { environment: report.environment, scope: report.scope } : {}),
    ...(keep.has('timeline') ? { timeline: report.timeline } : {}),
    ...(keep.has('requests') ? { requests: report.requests } : {}),
    ...(keep.has('code') ? { code: report.code } : {}),
    ...(keep.has('graph') && report.graph ? { graph: report.graph } : {}),
    ...(keep.has('hypotheses') ? { hypotheses: report.hypotheses } : {}),
    ...(keep.has('experiments') ? { experiments: report.experiments } : {}),
    ...(keep.has('diagnosis') && report.diagnosis ? { diagnosis: report.diagnosis } : {}),
    ...(keep.has('regression') && report.regression ? { regression: report.regression } : {}),
    ...(keep.has('ai') && report.ai ? { ai: report.ai } : {}),
    ...(keep.has('ai') && report.aiMemory ? { aiMemory: report.aiMemory } : {}),
    limitations: report.limitations,
  };
}

/** Le rapport en Markdown ; `sections` (par défaut toutes) choisit les parties rendues. */
export function reportMarkdown(report: InvestigationReport, sections?: readonly ReportSection[]): string {
  const out: string[] = [];
  const { incident } = report;
  const want = (section: ReportSection): boolean => sections === undefined || sections.includes(section);
  out.push(`# Rapport d'investigation — ${escapeMarkdown(incident.title)}`, '');
  out.push(
    `_Généré le ${report.generatedAt}. Incident ${escapeMarkdown(incident.id)} (projet ${escapeMarkdown(incident.projectId)})._`,
    '',
  );
  if (want('summary')) summaryMarkdown(report, out);
  if (want('environment')) environmentMarkdown(report, out);
  if (want('timeline')) timelineMarkdown(report, out);
  if (want('requests')) requestsMarkdown(report, out);
  if (want('code')) codeMarkdown(report, out);
  if (want('graph')) graphMarkdown(report, out);
  if (want('hypotheses')) hypothesesMarkdown(report, out);
  if (want('experiments')) experimentsMarkdown(report, out);
  if (want('diagnosis')) diagnosisMarkdown(report, out);
  if (want('regression')) regressionMarkdown(report, out);
  if (want('ai')) aiMarkdown(report, out);

  out.push('## Limites', '');
  if (report.limitations.length === 0) out.push('_Aucune._');
  for (const limitation of report.limitations) out.push(`- ${escapeMarkdown(limitation)}`);
  out.push('');
  return out.join('\n');
}

function summaryMarkdown(report: InvestigationReport, out: string[]): void {
  const { incident } = report;
  out.push('## Incident', '');
  out.push(`- **État** : ${incident.state}`);
  out.push(`- **Gravité** : ${incident.severity}`);
  out.push(`- **Description** : ${escapeMarkdown(incident.description)}`);
  out.push(`- **Observé** : ${escapeMarkdown(incident.observed)}`);
  out.push(`- **Attendu** : ${escapeMarkdown(incident.expected)}`);
  if (report.scenario) out.push(`- **Scénario** : ${escapeMarkdown(report.scenario)}`);
  out.push('');
  if (report.access) accessMarkdown(report.access, out);
}

/** Le scénario d'accès (saisi, masqué à l'enregistrement) et son analyse : des candidats, jamais des causes. */
function accessMarkdown(access: NonNullable<InvestigationReport['access']>, out: string[]): void {
  out.push("### Scénario d'accès", '');
  if (access.target) out.push(`- **Écran cible** : ${escapeMarkdown(access.target)}`);
  if (access.mode) out.push(`- **Mode** : ${ACCESS_MODE_LABELS[access.mode]}`);
  if (access.hints) out.push(`- **Indications de navigation** : ${escapeMarkdown(access.hints)}`);
  if (access.start) out.push(`- **Point de départ** : ${escapeMarkdown(access.start)}`);
  if (access.url) out.push(`- **URL ou route initiale** : ${escapeMarkdown(access.url)}`);
  if (access.narrative) out.push(`- **Parcours** : ${escapeMarkdown(access.narrative)}`);
  access.steps.forEach((step, index) => out.push(`  ${String(index + 1)}. ${escapeMarkdown(step.text)}`));
  if (access.expected) out.push(`- **Attendu** : ${escapeMarkdown(access.expected)}`);
  if (access.observed) out.push(`- **Observé** : ${escapeMarkdown(access.observed)}`);
  if (access.conditions) out.push(`- **Conditions** : ${escapeMarkdown(access.conditions)}`);
  if (access.recording) out.push(`- **Enregistrement associé** : ${escapeMarkdown(access.recording.name)}`);
  out.push('');
  targetMarkdown(access, out);
  const analysis = access.analysis;
  if (!analysis) return;
  out.push(`_Parcours analysé le ${analysis.analyzedAt} (${analysis.sources.join(' + ')})._`, '');
  const critical = analysis.path.find((step) => step.critical);
  if (critical) out.push(`- **Étape critique (déduite du texte)** : ${escapeMarkdown(critical.text)}`);
  const matched = analysis.candidates.filter((item) => item.match === 'MATCHED');
  const uncertain = analysis.candidates.filter((item) => item.match === 'UNCERTAIN');
  out.push(
    `- **Correspondances** : ${String(matched.length)} ; **incertaines** : ${String(uncertain.length)}`,
    '',
  );
  if (analysis.candidates.length > 0)
    out.push(
      ...table(
        ['Portion', 'Type', 'Emplacement', 'Confiance', 'Rapprochement', 'Périmètre'],
        analysis.candidates
          .slice(0, 20)
          .map((item) => [
            item.label,
            item.kind,
            item.ref,
            `${String(Math.round(item.confidence * 100))} %`,
            item.match === 'MATCHED' ? 'correspondance' : 'incertaine',
            item.status,
          ]),
      ),
      '',
    );
  if (analysis.leads.length > 0) {
    out.push('Pistes à vérifier (jamais des causes) :', '');
    for (const lead of analysis.leads)
      out.push(
        `- **${escapeMarkdown(lead.label)}** : ${escapeMarkdown(lead.why)}${lead.refs.length > 0 ? ` (${lead.refs.map(escapeMarkdown).join(', ')})` : ''}`,
      );
    out.push('');
  }
  for (const limit of analysis.limits) out.push(`- _${escapeMarkdown(limit)}_`);
  if (analysis.limits.length > 0) out.push('');
}

const ACCESS_MODE_LABELS: Record<NonNullable<IncidentAccess['mode']>, string> = {
  AUTO: 'exploration automatique',
  GUIDED: 'parcours guidé',
  DEMO: 'démonstration (enregistrement)',
};

/** L'écran cible : localisation (candidats et indices), parcours, écran atteint, exploration lancée. */
function targetMarkdown(access: NonNullable<InvestigationReport['access']>, out: string[]): void {
  const location = access.location;
  if (location) {
    out.push(
      `- **Écran localisé** : ${location.chosen ? escapeMarkdown(location.chosen) : 'aucun'} (localisé le ${location.locatedAt})`,
    );
    for (const candidate of location.candidates.slice(0, 5))
      out.push(
        `  - ${escapeMarkdown(candidate.route)}${candidate.component ? ` (${escapeMarkdown(candidate.component)})` : ''} : ${String(Math.round(candidate.confidence * 100))} %${candidate.nameOnly ? ', nom seul' : ''} ; ${candidate.evidence.map(escapeMarkdown).join(' ; ')}`,
      );
    if (location.path.length > 0)
      out.push(
        `- **Parcours trouvé** : ${location.path.map((step) => `${step.kind === 'NAVIGATE' ? 'aller à' : 'cliquer'} ${escapeMarkdown(step.label)}`).join(' → ')}`,
      );
    for (const limit of location.limits) out.push(`- _${escapeMarkdown(limit)}_`);
  }
  const preparation = access.preparation;
  if (preparation) {
    out.push(
      `- **Écran ${preparation.reached ? 'atteint' : 'non atteint'}** : ${escapeMarkdown(preparation.finalUrl || preparation.route)} (${String(preparation.inventory.buttons.length)} bouton(s), ${String(preparation.inventory.fields.length)} champ(s))`,
    );
    for (const blocker of preparation.blockers) out.push(`  - _${escapeMarkdown(blocker)}_`);
  }
  if (access.exploration)
    out.push(
      `- **Investigation lancée depuis l'écran cible** : run ${escapeMarkdown(access.exploration.runId)} le ${access.exploration.startedAt} (résultats dans la section des déclencheurs)`,
    );
  if (location || preparation || access.exploration) out.push('');
}

function environmentMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Environnement', '');
  out.push(`- **Cible d'exécution** : ${report.environment.execution.target}`);
  if (report.environment.environmentId)
    out.push(`- **Environnement** : ${escapeMarkdown(report.environment.environmentId)}`);
  if (report.environment.baseUrl) out.push(`- **URL** : ${escapeMarkdown(report.environment.baseUrl)}`);
  out.push('');

  out.push('## Périmètre', '');
  out.push(`- **Mode** : ${report.scope.mode} — profondeur ${String(report.scope.depth)}`);
  out.push(
    ...table(
      ['Application', 'Couche', 'Dépôt', 'Dossiers'],
      report.scope.applications.map((app) => [
        app.name,
        app.layer,
        app.repository.root,
        app.repository.include.join(', ') || '(racine)',
      ]),
    ),
  );
  if (report.scope.endpoints.length > 0)
    out.push('', `- **Endpoints** : ${escapeMarkdown(report.scope.endpoints.join(', '))}`);
  out.push('');
}

function timelineMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Chronologie', '');
  out.push(
    ...table(
      ['Heure', 'Étape', 'Sorte', 'Résumé'],
      report.timeline.map((entry) => [entry.at, entry.step, entry.kind, entry.summary]),
    ),
  );
  out.push('');
}

function requestsMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Requêtes', '');
  out.push(
    ...table(
      ['Méthode', 'Chemin', 'Statut', 'Étape', 'Corrélation'],
      report.requests.map((request) => [
        request.method,
        request.path,
        request.status ?? request.failure,
        request.step,
        request.correlation,
      ]),
    ),
  );
  for (const request of report.requests.filter(
    (item) => item.responseBody !== undefined || item.requestBody !== undefined,
  )) {
    out.push(
      '',
      `### ${escapeMarkdown(`${request.method} ${request.path}`)} (${String(request.status ?? request.failure ?? '?')})`,
      '',
    );
    if (request.requestBody !== undefined)
      out.push('Corps de la requête (masqué) :', '', ...codeBlock(request.requestBody, 'json'), '');
    if (request.responseBody !== undefined)
      out.push('Corps de la réponse (masqué) :', '', ...codeBlock(request.responseBody, 'json'));
  }
  out.push('');
}

function codeMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Code inspecté', '');
  out.push(
    ...table(
      ['Couche', 'Sorte', 'Symbole', 'Fichier'],
      report.code.symbols.map((symbol) => [
        symbol.layer,
        symbol.kind,
        symbol.name,
        `${symbol.file}:${String(symbol.line)}`,
      ]),
    ),
  );
  if (report.code.denied.length > 0) {
    out.push('', '**Refusés par le périmètre** :', '');
    for (const denied of report.code.denied)
      out.push(`- ${escapeMarkdown(denied.path)} — ${escapeMarkdown(denied.reason)}`);
  }
  out.push('');
}

function graphMarkdown(report: InvestigationReport, out: string[]): void {
  if (report.graph) {
    out.push("## Graphe d'investigation", '');
    out.push(
      '_OBSERVED : vu pendant l’exécution ; STATICALLY_RESOLVED : lu dans le code ; INFERRED : déduit, à vérifier ; UNKNOWN : lien manquant._',
      '',
    );
    out.push(...mermaid(report.graph), '');
    const labels = new Map(report.graph.nodes.map((node) => [node.id, node.label]));
    out.push(
      ...table(
        ['De', 'Vers', 'Statut', 'Raison'],
        report.graph.edges.map((edge) => [
          labels.get(edge.from) ?? edge.from,
          labels.get(edge.to) ?? edge.to,
          edge.status,
          edge.reason,
        ]),
      ),
    );
    out.push('');
  }
}

function hypothesesMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Hypothèses', '');
  if (report.hypotheses.length === 0) out.push('_Aucune hypothèse._');
  for (const hypothesis of report.hypotheses) {
    out.push(
      `### ${escapeMarkdown(hypothesis.title)}`,
      '',
      `- **Statut** : ${hypothesis.status} — confiance ${hypothesis.confidence.toFixed(2)} — couche ${hypothesis.layer}`,
      `- **Cause supposée** : ${escapeMarkdown(hypothesis.suspectedCause)}`,
    );
    if (hypothesis.files.length > 0)
      out.push(
        `- **Fichiers** : ${hypothesis.files.map((file) => `\`${file.replace(/`/g, '')}\``).join(', ')}`,
      );
    out.push('- **Preuves favorables** :');
    for (const item of hypothesis.supporting)
      out.push(`  - ${escapeMarkdown(item.fact)} (${escapeMarkdown(item.ref)})`);
    if (hypothesis.supporting.length === 0) out.push('  - aucune');
    out.push('- **Preuves contraires** :');
    for (const item of hypothesis.contradicting)
      out.push(`  - ${escapeMarkdown(item.fact)} (${escapeMarkdown(item.ref)})`);
    if (hypothesis.contradicting.length === 0) out.push('  - aucune');
    if (hypothesis.verifications.length > 0) {
      out.push('- **Vérifications proposées** :');
      for (const verification of hypothesis.verifications)
        out.push(`  - ${verification.kind} : ${escapeMarkdown(verification.description)}`);
    }
    out.push('');
  }
}

function experimentsMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Vérifications', '');
  out.push(
    ...table(
      ['Sorte', 'Hypothèse', 'Statut', 'Résultat', 'Résumé'],
      report.experiments.map((experiment) => [
        experiment.kind,
        experiment.hypothesisId,
        experiment.status,
        experiment.outcome,
        experiment.summary ?? experiment.description,
      ]),
    ),
  );
  out.push('');
}

function diagnosisMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Diagnostic', '');
  const diagnosis = report.diagnosis;
  if (!diagnosis) out.push('_Pas encore de diagnostic._');
  else {
    out.push(`- **Statut** : ${diagnosis.status}`);
    if (diagnosis.rootCause)
      out.push(
        `- **Cause racine${diagnosis.status === 'CONFIRMED' ? '' : ' (non confirmée)'}** : ${escapeMarkdown(diagnosis.rootCause.statement)} — couche ${diagnosis.rootCause.layer}`,
      );
    if (diagnosis.alternatives.length > 0) {
      out.push('- **Alternatives** :');
      for (const alternative of diagnosis.alternatives)
        out.push(`  - ${escapeMarkdown(alternative.statement)} (${alternative.confidence.toFixed(2)})`);
    }
    if (diagnosis.missing.length > 0) {
      out.push('- **Ce qui manque pour conclure** :');
      for (const item of diagnosis.missing) out.push(`  - ${escapeMarkdown(item)}`);
    }
    if (diagnosis.recommendations.length > 0) {
      out.push('- **Recommandations** :');
      for (const item of diagnosis.recommendations) out.push(`  - ${escapeMarkdown(item)}`);
    }
  }
  out.push('');
}

function regressionMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Test de non-régression', '');
  const regression = report.regression;
  if (!regression) out.push('_Aucun test proposé._');
  else {
    out.push(`- **Nom** : ${escapeMarkdown(regression.name)} (${regression.status})`);
    out.push(`- **Attendu** : ${escapeMarkdown(regression.expected)}`);
    out.push(
      `- **Exécution** : ${
        regression.execution
          ? `${regression.execution.passed ? 'réussi' : 'échoué'} (run ${escapeMarkdown(regression.execution.run)}, ${regression.execution.at})`
          : 'pas encore exécuté'
      }`,
    );
    out.push('', ...codeBlock(regression.flowYaml, 'yaml'));
  }
  out.push('');
}

// ── Investigation IA ─────────────────────────────────────────────────────────────────────────

const USAGE_LABELS: [keyof AiInvestigationRun['usage'], string][] = [
  ['modelCalls', 'appels au modèle'],
  ['toolCalls', "appels d'outils"],
  ['inputTokens', 'jetons en entrée'],
  ['outputTokens', 'jetons en sortie'],
  ['files', 'fichiers lus'],
  ['experiments', 'vérifications lancées'],
];

/**
 * La section « Investigation IA » : ce que les agents ont proposé (jamais confirmé), avec le mode, la profondeur,
 * l'arrêt et la consommation réels ; puis, quand la mémoire existe, les dix-neuf points de l'investigation
 * approfondie (stratégies tentées ou non, rôles des hypothèses, contradictions, vérifications menées ou en
 * attente, couverture par dimension, limites, permissions, raison d'arrêt). Rien n'est inventé : chaque ligne
 * vient d'un run ou de la mémoire.
 */
function aiMarkdown(report: InvestigationReport, out: string[]): void {
  out.push('## Investigation IA', '');
  const ai = report.ai;
  if (!ai || ai.runs.length === 0) {
    out.push(
      "_Aucune investigation IA n'a eu lieu : le diagnostic ci-dessus est entièrement déterministe._",
      '',
    );
    return;
  }
  out.push(
    '_Les hypothèses et relations proposées par les agents sont des propositions à vérifier ; seul le validateur déterministe confirme une cause._',
    '',
  );
  for (const run of ai.runs) {
    out.push(
      `### Run ${escapeMarkdown(run.id)} — ${run.mode}${run.depth ? ` / ${run.depth}` : ''} — ${run.status}${run.stopReason ? ` (${run.stopReason})` : ''}`,
      '',
      `- **Lancé** : ${run.startedAt} par ${escapeMarkdown(run.startedBy)}${run.finishedAt ? `, terminé ${run.finishedAt}` : ''}`,
      ...(run.provider || run.model
        ? [`- **Fournisseur** : ${escapeMarkdown([run.provider, run.model].filter(Boolean).join(' / '))}`]
        : []),
      `- **Consommation** : ${USAGE_LABELS.map(([key, label]) => `${String(run.usage[key])} ${label}`).join(', ')}`,
    );
    if (run.error) out.push(`- **Erreur** : ${escapeMarkdown(run.error)}`);
    out.push('', '**Agents**', '');
    out.push(
      ...table(
        ['Agent', 'Statut', 'Résumé'],
        run.steps.map((step) => [step.agent, step.status, step.summary ?? step.error]),
      ),
    );
    if (run.findings.length > 0) {
      out.push('', '**Constats**', '');
      out.push(
        ...table(
          ['Agent', 'Couche', 'Base', 'Constat', 'Références'],
          run.findings.map((finding) => [
            finding.agent,
            finding.layer,
            finding.basis,
            `${finding.title} — ${finding.summary}`,
            finding.refs.map((ref) => ref.id).join(', '),
          ]),
        ),
      );
    }
    if (run.hypothesisIds.length > 0)
      out.push('', `- **Hypothèses proposées (origine IA, PROPOSED)** : ${run.hypothesisIds.join(', ')}`);
    if (run.proposals.length > 0) {
      out.push('', '**Vérifications proposées**', '');
      out.push(
        ...table(
          ['Proposition', 'Hypothèse', 'Sorte', 'Effets de bord', 'Statut', 'Vérification planifiée'],
          run.proposals.map((proposal) => [
            proposal.id,
            proposal.hypothesisId,
            proposal.kind,
            proposal.sideEffects ? 'avec' : 'sans',
            proposal.status,
            proposal.experimentId ?? proposal.refusal,
          ]),
        ),
      );
    }
    if (run.synthesis) {
      out.push('', '**Synthèse (proposition de l’agent)**', '', escapeMarkdown(run.synthesis.summary));
      if (run.synthesis.ranking.length > 0)
        out.push(`- **Ordre de vraisemblance** : ${run.synthesis.ranking.join(', ')}`);
      if (run.synthesis.missing.length > 0)
        out.push(`- **Ce qui manque** : ${run.synthesis.missing.map(escapeMarkdown).join(' ; ')}`);
    }
    if (run.limitations.length > 0) {
      out.push('', '**Limites du run**', '');
      for (const limitation of run.limitations) out.push(`- ${escapeMarkdown(limitation)}`);
    }
    out.push('');
  }
  if (ai.answers.length > 0)
    out.push(
      `- **Questions posées à l'assistant** : ${String(ai.answers.length)} (réponses conservées dans l'incident)`,
      '',
    );
  const memory = report.aiMemory;
  if (memory) deepMarkdown(memory, out);
}

function deepMarkdown(memory: InvestigationMemory, out: string[]): void {
  out.push('### Investigation approfondie', '');
  out.push(
    `- **Profondeur / mode** : ${memory.depth} / ${memory.mode} — **état** : ${memory.status}${memory.stopReason ? ` (${memory.stopReason})` : ''}`,
    `- **Budget** : ${String(memory.budget.maxIterations)} itération(s), ${String(memory.budget.maxModelCalls)} appel(s) au modèle, ${String(memory.budget.maxExperiments)} vérification(s)${memory.budget.extensions.length > 0 ? ` ; ${String(memory.budget.extensions.length)} prolongation(s) accordée(s)` : ''}`,
    `- **Consommé** : ${String(memory.usage.iterations)} itération(s), ${String(memory.usage.modelCalls)} appel(s) au modèle, ${String(memory.usage.experiments)} vérification(s)`,
    '',
    '**Stratégies**',
    '',
    ...table(
      ['Stratégie', 'Catégorie', 'Statut', 'Tentatives', 'Raison'],
      memory.strategies.map((strategy) => [
        strategy.name,
        strategy.category,
        strategy.status,
        strategy.attempts,
        strategy.reason,
      ]),
    ),
    '',
    '**Rôles des hypothèses (validateur déterministe et vérifications)**',
    '',
    ...table(
      ['Hypothèse', 'Origine', 'Rôle', 'Vérifications', 'Inconnues'],
      memory.explorations.map((exploration) => [
        exploration.hypothesisId,
        exploration.origin,
        exploration.role,
        exploration.verifications.length,
        exploration.unknowns.join(' ; '),
      ]),
    ),
    '',
    '**Contradictions**',
    '',
    ...table(
      ['Id', 'Hypothèse', 'Sorte', 'Statut', 'Question ouverte', 'Résumé'],
      memory.contradictions.map((contradiction) => [
        contradiction.id,
        contradiction.hypothesisId,
        contradiction.kind,
        contradiction.status,
        contradiction.openQuestion ? 'question' : 'constat',
        contradiction.summary,
      ]),
    ),
    '',
    '**Vérifications générées**',
    '',
    ...table(
      ['Id', 'Hypothèse', 'Sorte', 'Statut', 'Effets de bord', 'Approbation'],
      memory.experiments.map((experiment) => [
        experiment.id,
        experiment.hypothesisId,
        experiment.kind,
        experiment.status,
        experiment.sideEffects ? 'avec' : 'sans',
        experiment.permissions.join(' ; ') || (experiment.status === 'PROPOSED' ? 'aucune' : undefined),
      ]),
    ),
    '',
    '**Couverture (par dimension, dénominateur explicite)**',
    '',
    ...table(
      ['Dimension', 'État', 'Examiné', 'Total', 'Dénominateur', 'Raison'],
      memory.coverage.map((entry) => [
        entry.dimension,
        entry.state,
        entry.examined,
        entry.total,
        entry.denominator,
        entry.reason,
      ]),
    ),
  );
  if (memory.permissions.length > 0) {
    out.push('', '**Permissions (liées à une opération et à ses paramètres)**', '');
    out.push(
      ...table(
        ['Quand', 'Qui', 'Opération', 'Paramètres', 'Décision'],
        memory.permissions.map((permission) => [
          permission.at,
          permission.by,
          permission.operation,
          Object.entries(permission.parameters)
            .map(([key, value]) => `${key}=${value}`)
            .join(', '),
          permission.decision,
        ]),
      ),
    );
  }
  if (memory.limits.length > 0) {
    out.push('', '**Limites atteintes**', '');
    for (const limit of memory.limits)
      out.push(
        `- ${limit.at} : ${limit.limit} — ${String(limit.remaining.length)} piste(s) restante(s)${
          limit.proposedExtension
            ? ` ; prolongation proposée : ${Object.entries(limit.proposedExtension)
                .map(([key, value]) => `${key} +${String(value)}`)
                .join(', ')}`
            : ''
        }`,
      );
  }
  if (memory.remaining.length > 0) {
    out.push('', '**Ce qui reste à faire**', '');
    for (const item of memory.remaining) out.push(`- ${escapeMarkdown(item)}`);
  }
  out.push('');
}
