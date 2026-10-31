import { redactText } from '../security/redactor.js';
import { incidentReproduction } from './evidence.js';
import type {
  CodeSymbol,
  GraphEdge,
  HttpExchange,
  Incident,
  InvestigationGraph,
  InvestigationReport,
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

export function buildReport(incident: Incident, now: Date): InvestigationReport {
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
    timeline: reproduction ? timelineOf(reproduction) : [],
    requests: (reproduction?.requests ?? []).map(redactRequest),
    code: { files, symbols, denied: code?.denied ?? [], truncated: code?.truncated ?? [] },
    ...(graph ? { graph } : {}),
    hypotheses: investigation.hypotheses,
    experiments: investigation.experiments,
    ...(investigation.diagnosis ? { diagnosis: investigation.diagnosis } : {}),
    ...(investigation.regression ? { regression: investigation.regression } : {}),
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

export function reportMarkdown(report: InvestigationReport): string {
  const out: string[] = [];
  const { incident } = report;
  out.push(`# Rapport d'investigation — ${escapeMarkdown(incident.title)}`, '');
  out.push(
    `_Généré le ${report.generatedAt}. Incident ${escapeMarkdown(incident.id)} (projet ${escapeMarkdown(incident.projectId)})._`,
    '',
  );

  out.push('## Incident', '');
  out.push(`- **État** : ${incident.state}`);
  out.push(`- **Gravité** : ${incident.severity}`);
  out.push(`- **Description** : ${escapeMarkdown(incident.description)}`);
  out.push(`- **Observé** : ${escapeMarkdown(incident.observed)}`);
  out.push(`- **Attendu** : ${escapeMarkdown(incident.expected)}`);
  if (report.scenario) out.push(`- **Scénario** : ${escapeMarkdown(report.scenario)}`);
  out.push('');

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

  out.push('## Chronologie', '');
  out.push(
    ...table(
      ['Heure', 'Étape', 'Sorte', 'Résumé'],
      report.timeline.map((entry) => [entry.at, entry.step, entry.kind, entry.summary]),
    ),
  );
  out.push('');

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

  out.push('## Limites', '');
  if (report.limitations.length === 0) out.push('_Aucune._');
  for (const limitation of report.limitations) out.push(`- ${escapeMarkdown(limitation)}`);
  out.push('');
  return out.join('\n');
}
