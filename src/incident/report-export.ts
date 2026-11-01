import type { Browser, BrowserType } from 'playwright';
import type { InvestigationReport, ReportSection } from './model.js';

/**
 * LES EXPORTS DU RAPPORT : un document HTML autonome (styles en ligne, aucun script, aucune ressource
 * externe, tout le texte échappé) et le PDF de ce même document, imprimé par Chromium sans interface
 * (Playwright). Sans Chromium, le PDF est indisponible (PdfUnavailableError) : rien n'est simulé.
 */

export function escapeHtml(text: string | number | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const cell = (value: string | number | undefined): string =>
  value === undefined || value === '' ? '—' : escapeHtml(value);

function table(headers: string[], rows: (string | number | undefined)[][]): string {
  if (rows.length === 0) return '<p class="empty">Aucun élément.</p>';
  return `<table><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((value) => `<td>${cell(value)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

const pre = (text: string): string => `<pre>${escapeHtml(text)}</pre>`;

const item = (label: string, value: string | number | undefined): string =>
  `<li><strong>${escapeHtml(label)}</strong> : ${cell(value)}</li>`;

function section(id: ReportSection | 'limitations', title: string, body: string): string {
  return `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${escapeHtml(title)}</h2>${body}</section>`;
}

const STYLE = `
:root{--bg:#ffffff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--head:#f6f8fa;--accent:#0b5cad;--code:#f6f8fa}
@media screen and (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--head:#161b22;--accent:#6cb6ff;--code:#161b22}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line);color:var(--accent)}
h3{font-size:15px;margin:16px 0 6px}
.meta,.empty,.note{color:var(--muted)}
ul{padding-left:20px;margin:6px 0}
table{border-collapse:collapse;width:100%;margin:6px 0;font-size:13px}
th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top;word-break:break-word}
th{background:var(--head)}
pre{background:var(--code);border:1px solid var(--line);padding:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media print{:root{--bg:#ffffff;--fg:#000000;--muted:#444444;--line:#999999;--head:#eeeeee;--accent:#000000;--code:#f4f4f4}body{padding:0}h2{break-after:avoid}tr,pre{break-inside:avoid}}
`;

/** Le rapport en document HTML autonome ; `sections` (par défaut toutes) choisit les parties rendues. */
export function reportHtml(report: InvestigationReport, sections?: readonly ReportSection[]): string {
  const want = (name: ReportSection): boolean => sections === undefined || sections.includes(name);
  const { incident } = report;
  const parts: string[] = [];

  if (want('summary'))
    parts.push(
      section(
        'summary',
        'Incident',
        `<ul>${[
          item('État', incident.state),
          item('Gravité', incident.severity),
          item('Description', incident.description),
          item('Observé', incident.observed),
          item('Attendu', incident.expected),
          ...(report.scenario ? [item('Scénario', report.scenario)] : []),
        ].join('')}</ul>`,
      ),
    );

  if (want('environment')) {
    const scope = report.scope;
    parts.push(
      section(
        'environment',
        'Environnement et périmètre',
        `<ul>${[
          item("Cible d'exécution", report.environment.execution.target),
          ...(report.environment.environmentId
            ? [item('Environnement', report.environment.environmentId)]
            : []),
          ...(report.environment.baseUrl ? [item('URL', report.environment.baseUrl)] : []),
          item('Mode', scope.mode),
          item('Profondeur', scope.depth),
          ...(scope.limits.maxMemoryMb !== undefined
            ? [item('Mémoire maximale (Mio)', scope.limits.maxMemoryMb)]
            : []),
        ].join('')}</ul>${table(
          ['Application', 'Couche', 'Dépôt', 'Dossiers'],
          scope.applications.map((application) => [
            application.name,
            application.layer,
            application.repository.root,
            application.repository.include.join(', ') || '(racine)',
          ]),
        )}${
          scope.endpoints.length > 0
            ? `<p><strong>Endpoints</strong> : ${escapeHtml(scope.endpoints.join(', '))}</p>`
            : ''
        }`,
      ),
    );
  }

  if (want('timeline'))
    parts.push(
      section(
        'timeline',
        'Chronologie',
        table(
          ['Heure', 'Étape', 'Sorte', 'Résumé'],
          report.timeline.map((entry) => [entry.at, entry.step, entry.kind, entry.summary]),
        ),
      ),
    );

  if (want('requests')) {
    const bodies = report.requests
      .filter((request) => request.requestBody !== undefined || request.responseBody !== undefined)
      .map(
        (request) =>
          `<h3>${escapeHtml(`${request.method} ${request.path}`)} (${escapeHtml(String(request.status ?? request.failure ?? '?'))})</h3>${
            request.requestBody !== undefined
              ? `<p class="note">Corps de la requête (masqué) :</p>${pre(request.requestBody)}`
              : ''
          }${
            request.responseBody !== undefined
              ? `<p class="note">Corps de la réponse (masqué) :</p>${pre(request.responseBody)}`
              : ''
          }`,
      )
      .join('');
    parts.push(
      section(
        'requests',
        'Requêtes',
        `${table(
          ['Méthode', 'Chemin', 'Statut', 'Étape', 'Corrélation'],
          report.requests.map((request) => [
            request.method,
            request.path,
            request.status ?? request.failure,
            request.step,
            request.correlation,
          ]),
        )}${bodies}`,
      ),
    );
  }

  if (want('graph')) {
    const graph = report.graph;
    if (!graph)
      parts.push(section('graph', "Graphe d'investigation", '<p class="empty">Graphe non construit.</p>'));
    else {
      const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
      parts.push(
        section(
          'graph',
          "Graphe d'investigation",
          `<p class="note">OBSERVED : vu pendant l’exécution ; STATICALLY_RESOLVED : lu dans le code ; INFERRED : déduit, à vérifier ; UNKNOWN : lien manquant.</p>${table(
            ['De', 'Vers', 'Statut', 'Raison'],
            graph.edges.map((edge) => [
              labels.get(edge.from) ?? edge.from,
              labels.get(edge.to) ?? edge.to,
              edge.status,
              edge.reason,
            ]),
          )}`,
        ),
      );
    }
  }

  if (want('code'))
    parts.push(
      section(
        'code',
        'Code inspecté',
        `${table(
          ['Couche', 'Sorte', 'Symbole', 'Fichier'],
          report.code.symbols.map((symbol) => [
            symbol.layer,
            symbol.kind,
            symbol.name,
            `${symbol.file}:${String(symbol.line)}`,
          ]),
        )}${
          report.code.denied.length > 0
            ? `<h3>Refusés par le périmètre</h3><ul>${report.code.denied
                .map((denied) => `<li>${escapeHtml(denied.path)} — ${escapeHtml(denied.reason)}</li>`)
                .join('')}</ul>`
            : ''
        }`,
      ),
    );

  if (want('hypotheses'))
    parts.push(
      section(
        'hypotheses',
        'Hypothèses',
        report.hypotheses.length === 0
          ? '<p class="empty">Aucune hypothèse.</p>'
          : report.hypotheses
              .map(
                (hypothesis) =>
                  `<h3>${escapeHtml(hypothesis.title)}</h3><ul>${[
                    item(
                      'Statut',
                      `${hypothesis.status} — confiance ${hypothesis.confidence.toFixed(2)} — couche ${hypothesis.layer}`,
                    ),
                    item('Cause supposée', hypothesis.suspectedCause),
                    ...(hypothesis.files.length > 0 ? [item('Fichiers', hypothesis.files.join(', '))] : []),
                  ].join('')}<li><strong>Preuves favorables</strong> :<ul>${
                    hypothesis.supporting.length === 0
                      ? '<li>aucune</li>'
                      : hypothesis.supporting
                          .map((entry) => `<li>${escapeHtml(entry.fact)} (${escapeHtml(entry.ref)})</li>`)
                          .join('')
                  }</ul></li><li><strong>Preuves contraires</strong> :<ul>${
                    hypothesis.contradicting.length === 0
                      ? '<li>aucune</li>'
                      : hypothesis.contradicting
                          .map((entry) => `<li>${escapeHtml(entry.fact)} (${escapeHtml(entry.ref)})</li>`)
                          .join('')
                  }</ul></li></ul>`,
              )
              .join(''),
      ),
    );

  if (want('experiments'))
    parts.push(
      section(
        'experiments',
        'Vérifications',
        table(
          ['Sorte', 'Hypothèse', 'Statut', 'Résultat', 'Résumé'],
          report.experiments.map((experiment) => [
            experiment.kind,
            experiment.hypothesisId,
            experiment.status,
            experiment.outcome,
            experiment.summary ?? experiment.description,
          ]),
        ),
      ),
    );

  if (want('diagnosis')) {
    const diagnosis = report.diagnosis;
    parts.push(
      section(
        'diagnosis',
        'Diagnostic',
        !diagnosis
          ? '<p class="empty">Pas encore de diagnostic.</p>'
          : `<ul>${[
              item('Statut', diagnosis.status),
              ...(diagnosis.rootCause
                ? [
                    item(
                      diagnosis.status === 'CONFIRMED' ? 'Cause racine' : 'Cause racine (non confirmée)',
                      `${diagnosis.rootCause.statement} — couche ${diagnosis.rootCause.layer}`,
                    ),
                  ]
                : []),
            ].join('')}</ul>${list(
              'Alternatives',
              diagnosis.alternatives.map((entry) => `${entry.statement} (${entry.confidence.toFixed(2)})`),
            )}${list(
              'Ce qui manque pour conclure',
              diagnosis.missing,
            )}${list('Recommandations', diagnosis.recommendations)}`,
      ),
    );
  }

  if (want('regression')) {
    const regression = report.regression;
    parts.push(
      section(
        'regression',
        'Test de non-régression',
        !regression
          ? '<p class="empty">Aucun test proposé.</p>'
          : `<ul>${[
              item('Nom', `${regression.name} (${regression.status})`),
              item('Attendu', regression.expected),
              item(
                'Exécution',
                regression.execution
                  ? `${regression.execution.passed ? 'réussi' : 'échoué'} (run ${regression.execution.run}, ${regression.execution.at})`
                  : 'pas encore exécuté',
              ),
            ].join('')}</ul>${pre(regression.flowYaml)}`,
      ),
    );
  }

  if (want('ai')) parts.push(section('ai', 'Investigation IA', aiHtml(report)));

  parts.push(
    section(
      'limitations',
      'Limites',
      report.limitations.length === 0
        ? '<p class="empty">Aucune.</p>'
        : `<ul>${report.limitations.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`,
    ),
  );

  return [
    '<!doctype html>',
    '<html lang="fr">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(`Rapport d'investigation — ${incident.title}`)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(`Rapport d'investigation — ${incident.title}`)}</h1>`,
    `<p class="meta">Généré le ${escapeHtml(report.generatedAt)}. Incident ${escapeHtml(incident.id)} (projet ${escapeHtml(incident.projectId)}).</p>`,
    ...parts,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** L'investigation IA : des propositions datées et bornées, jamais une confirmation ; puis la mémoire approfondie. */
function aiHtml(report: InvestigationReport): string {
  const ai = report.ai;
  if (!ai || ai.runs.length === 0)
    return '<p class="empty">Aucune investigation IA : le diagnostic est entièrement déterministe.</p>';
  const runs = ai.runs
    .map(
      (run) =>
        `<h3>${escapeHtml(`Run ${run.id} — ${run.mode}${run.depth ? ` / ${run.depth}` : ''} — ${run.status}${run.stopReason ? ` (${run.stopReason})` : ''}`)}</h3><ul>${[
          item(
            'Lancé',
            `${run.startedAt} par ${run.startedBy}${run.finishedAt ? `, terminé ${run.finishedAt}` : ''}`,
          ),
          ...(run.provider || run.model
            ? [item('Fournisseur', [run.provider, run.model].filter(Boolean).join(' / '))]
            : []),
          item(
            'Consommation',
            `${String(run.usage.modelCalls)} appels au modèle, ${String(run.usage.toolCalls)} appels d'outils, ${String(run.usage.files)} fichiers lus, ${String(run.usage.experiments)} vérifications lancées`,
          ),
          ...(run.error ? [item('Erreur', run.error)] : []),
          ...(run.hypothesisIds.length > 0
            ? [item('Hypothèses proposées (origine IA, PROPOSED)', run.hypothesisIds.join(', '))]
            : []),
        ].join('')}</ul>${table(
          ['Agent', 'Statut', 'Résumé'],
          run.steps.map((step) => [step.agent, step.status, step.summary ?? step.error]),
        )}${
          run.findings.length > 0
            ? `<h4>Constats</h4>${table(
                ['Agent', 'Couche', 'Base', 'Constat', 'Références'],
                run.findings.map((finding) => [
                  finding.agent,
                  finding.layer,
                  finding.basis,
                  `${finding.title} — ${finding.summary}`,
                  finding.refs.map((ref) => ref.id).join(', '),
                ]),
              )}`
            : ''
        }${
          run.proposals.length > 0
            ? `<h4>Vérifications proposées</h4>${table(
                ['Proposition', 'Hypothèse', 'Sorte', 'Effets de bord', 'Statut', 'Vérification planifiée'],
                run.proposals.map((proposal) => [
                  proposal.id,
                  proposal.hypothesisId,
                  proposal.kind,
                  proposal.sideEffects ? 'avec' : 'sans',
                  proposal.status,
                  proposal.experimentId ?? proposal.refusal,
                ]),
              )}`
            : ''
        }${
          run.synthesis
            ? `<h4>Synthèse (proposition de l’agent)</h4><p>${escapeHtml(run.synthesis.summary)}</p>${list('Ordre de vraisemblance', run.synthesis.ranking)}${list('Ce qui manque', run.synthesis.missing)}`
            : ''
        }${list('Limites du run', run.limitations)}`,
    )
    .join('');
  const memory = report.aiMemory;
  const deep = memory
    ? `<h3>Investigation approfondie</h3><ul>${[
        item('Profondeur / mode', `${memory.depth} / ${memory.mode}`),
        item('État', `${memory.status}${memory.stopReason ? ` (${memory.stopReason})` : ''}`),
        item(
          'Budget',
          `${String(memory.budget.maxIterations)} itération(s), ${String(memory.budget.maxModelCalls)} appel(s) au modèle, ${String(memory.budget.maxExperiments)} vérification(s)${memory.budget.extensions.length > 0 ? ` ; ${String(memory.budget.extensions.length)} prolongation(s)` : ''}`,
        ),
        item(
          'Consommé',
          `${String(memory.usage.iterations)} itération(s), ${String(memory.usage.modelCalls)} appel(s) au modèle, ${String(memory.usage.experiments)} vérification(s)`,
        ),
      ].join('')}</ul><h4>Stratégies</h4>${table(
        ['Stratégie', 'Catégorie', 'Statut', 'Tentatives', 'Raison'],
        memory.strategies.map((strategy) => [
          strategy.name,
          strategy.category,
          strategy.status,
          strategy.attempts,
          strategy.reason,
        ]),
      )}<h4>Rôles des hypothèses</h4>${table(
        ['Hypothèse', 'Origine', 'Rôle', 'Vérifications', 'Inconnues'],
        memory.explorations.map((exploration) => [
          exploration.hypothesisId,
          exploration.origin,
          exploration.role,
          exploration.verifications.length,
          exploration.unknowns.join(' ; '),
        ]),
      )}<h4>Contradictions</h4>${table(
        ['Id', 'Hypothèse', 'Sorte', 'Statut', 'Question ouverte', 'Résumé'],
        memory.contradictions.map((contradiction) => [
          contradiction.id,
          contradiction.hypothesisId,
          contradiction.kind,
          contradiction.status,
          contradiction.openQuestion ? 'question' : 'constat',
          contradiction.summary,
        ]),
      )}<h4>Vérifications générées</h4>${table(
        ['Id', 'Hypothèse', 'Sorte', 'Statut', 'Effets de bord', 'Approbation'],
        memory.experiments.map((experiment) => [
          experiment.id,
          experiment.hypothesisId,
          experiment.kind,
          experiment.status,
          experiment.sideEffects ? 'avec' : 'sans',
          experiment.permissions.join(' ; ') || (experiment.status === 'PROPOSED' ? 'aucune' : undefined),
        ]),
      )}<h4>Couverture (par dimension, dénominateur explicite)</h4>${table(
        ['Dimension', 'État', 'Examiné', 'Total', 'Dénominateur', 'Raison'],
        memory.coverage.map((entry) => [
          entry.dimension,
          entry.state,
          entry.examined,
          entry.total,
          entry.denominator,
          entry.reason,
        ]),
      )}${list(
        'Limites atteintes',
        memory.limits.map(
          (limit) => `${limit.at} : ${limit.limit} — ${String(limit.remaining.length)} piste(s) restante(s)`,
        ),
      )}${list('Ce qui reste à faire', memory.remaining)}`
    : '';
  return `<p class="note">Les hypothèses et relations proposées par les agents sont des propositions à vérifier ; seul le validateur déterministe confirme une cause.</p>${runs}${deep}`;
}

function list(title: string, entries: string[]): string {
  if (entries.length === 0) return '';
  return `<h3>${escapeHtml(title)}</h3><ul>${entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`;
}

// ── PDF ──────────────────────────────────────────────────────────────────────────────────────

/** Chromium n'a pas pu être lancé (absent, non installé) : le PDF n'est pas disponible ici. */
export class PdfUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfUnavailableError';
  }
}

/** L'impression a dépassé le délai : Chromium est arrêté, rien n'est rendu. */
export class PdfTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`PDF rendering did not finish within ${String(timeoutMs)} ms`);
    this.name = 'PdfTimeoutError';
  }
}

export type PdfRenderer = (html: string, options: { timeoutMs: number }) => Promise<Uint8Array>;

export const PDF_TIMEOUT_MS = 30_000;

/** Une impression à la fois : un Chromium par export, jamais plusieurs en parallèle. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Imprime le HTML avec Chromium sans interface (Playwright) : JavaScript désactivé, hors ligne. Tout
 * est asynchrone (Chromium tourne à part) ; un délai borne l'ensemble et ferme le navigateur s'il est dépassé.
 */
export const renderPdf: PdfRenderer = (html, options) => {
  const run = queue.then(
    () => printWithChromium(html, options.timeoutMs),
    () => printWithChromium(html, options.timeoutMs),
  );
  queue = run.catch(() => undefined);
  return run;
};

async function printWithChromium(html: string, timeoutMs: number): Promise<Uint8Array> {
  let chromium: BrowserType;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    throw new PdfUnavailableError(`Playwright is not available: ${message(error)}`);
  }
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: timeoutMs, handleSIGINT: false });
  } catch (error) {
    throw new PdfUnavailableError(`Chromium cannot be started: ${firstLine(message(error))}`);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PdfTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
        const pdf = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' },
        });
        return new Uint8Array(pdf);
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await browser.close().catch(() => undefined);
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const firstLine = (text: string): string => text.split('\n')[0]?.slice(0, 300) ?? text;
