import type { ExplorationResult } from '../model/exploration-result.js';
import { esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/**
 * Sections « État des formulaires », « Règles de l'application » et « Dépendances
 * entre champs » : ce que le code annonce, ce que le navigateur a confirmé ou
 * contredit, ce qui reste à vérifier. Jamais une valeur saisie ou préremplie.
 */
const TEXTS = {
  en: {
    formState: 'Form state',
    formStateHint: 'Why each value is present and what the crawler does with it. Values are never shown.',
    stateColumns: ['Field', 'State', 'Origin', 'Source', 'Decision', 'Why'],
    rules: 'Application rules',
    rulesHint:
      'Rules found in the code are hypotheses (STATIC_DISCOVERED) until the browser confirms or contradicts them. A contradiction is not a bug by itself.',
    coverage: 'Rule coverage',
    coverageRows: {
      discovered: 'Rules discovered',
      confirmed: 'Runtime confirmed',
      contradicted: 'Runtime contradicted',
      partial: 'Partially verified',
      notVerified: 'Not verified',
      blocked: 'Blocked by policy / context',
      inconclusive: 'Inconclusive',
      verified: 'Coverage (verified / discovered)',
      technical: 'Technical conditions (not rules)',
    },
    coverageNote: 'A count, not a quality verdict.',
    rule: 'Rule',
    category: 'Category',
    condition: 'Condition',
    effects: 'Effects',
    source: 'Static source',
    runtime: 'Runtime',
    network: 'Network effect',
    confidence: 'Confidence',
    blocked: 'Not verified because',
    contradiction: 'Contradiction context',
    history: 'Earlier runs',
    tree: 'Rule graph',
    dependencies: 'Field dependencies',
    dependencyColumns: ['From', 'To', 'Kind', 'Evidence', 'When'],
    noRules: {
      noCode: (status: string) =>
        `No rule found: no application code was read (static analysis ${status}). Rules are read in the code: set staticAnalysis.source.git (the repository) or source.root.`,
      bundle:
        'No rule found: only the minified bundles were read (BUNDLE) — the conditions of the forms cannot be read there. Give the source code (staticAnalysis.source.git) or publish the source maps.',
      noForm: (files: number) =>
        `No rule found in the ${String(files)} file(s) read: no reactive form (FormGroup / FormBuilder) with a condition was recognised. Check staticAnalysis.source.git path (the front-end folder).`,
    },
  },
  fr: {
    formState: 'État des formulaires',
    formStateHint:
      'Pourquoi chaque valeur est là et ce que le crawler en fait. Les valeurs ne sont jamais affichées.',
    stateColumns: ['Champ', 'État', 'Origine', 'Source', 'Décision', 'Pourquoi'],
    rules: 'Règles de l’application',
    rulesHint:
      'Une règle lue dans le code est une hypothèse (STATIC_DISCOVERED) tant que le navigateur ne l’a pas confirmée ou contredite. Une contradiction n’est pas un bug en soi.',
    coverage: 'Couverture des règles',
    coverageRows: {
      discovered: 'Règles découvertes',
      confirmed: 'Confirmées à l’exécution',
      contradicted: 'Contredites à l’exécution',
      partial: 'Vérifiées en partie',
      notVerified: 'Non vérifiées',
      blocked: 'Bloquées (politique / contexte)',
      inconclusive: 'Non concluantes',
      verified: 'Couverture (vérifiées / découvertes)',
      technical: 'Conditions techniques (pas des règles)',
    },
    coverageNote: 'Un décompte, pas un verdict de qualité.',
    rule: 'Règle',
    category: 'Catégorie',
    condition: 'Condition',
    effects: 'Effets',
    source: 'Source statique',
    runtime: 'Exécution',
    network: 'Effet réseau',
    confidence: 'Confiance',
    blocked: 'Non vérifiée parce que',
    contradiction: 'Contexte de la contradiction',
    history: 'Runs précédents',
    tree: 'Graphe des règles',
    dependencies: 'Dépendances entre champs',
    dependencyColumns: ['De', 'Vers', 'Genre', 'Preuve', 'Quand'],
    noRules: {
      noCode: (status: string) =>
        `Aucune règle : aucun code de l’application n’a été lu (analyse statique ${status}). Les règles se lisent dans le code : renseignez staticAnalysis.source.git (le dépôt) ou source.root.`,
      bundle:
        'Aucune règle : seuls les bundles minifiés ont été lus (BUNDLE) — les conditions des formulaires ne s’y lisent pas. Donnez le code source (staticAnalysis.source.git) ou publiez les source maps.',
      noForm: (files: number) =>
        `Aucune règle dans les ${String(files)} fichier(s) lus : aucun formulaire réactif (FormGroup / FormBuilder) avec une condition n’a été reconnu. Vérifiez le path de staticAnalysis.source.git (le dossier du front-end).`,
    },
  },
} as const;

const STATUS_COLOR: Record<string, string> = {
  RUNTIME_CONFIRMED: '#2e7d32',
  RUNTIME_CONTRADICTED: '#c62828',
  RUNTIME_OBSERVED: '#1565c0',
  INCONCLUSIVE: '#6d4c41',
  STATIC_DISCOVERED: '#757575',
};

const VERDICT_MARK: Record<string, string> = {
  CONFIRMED: '✓',
  CONTRADICTED: '✗',
  INCONCLUSIVE: '?',
  NOT_VERIFIED: '·',
};

/** Pourquoi la section des règles est vide : rien lu, seulement du minifié, ou aucun formulaire reconnu. */
function whyNoRules(result: ExplorationResult, language: ReportLanguage): string {
  const texts = TEXTS[language].noRules;
  const analysis = result.staticAnalysis;
  if (!analysis || analysis.status !== 'USED') return texts.noCode(analysis?.status ?? 'DISABLED');
  if (analysis.mode === 'BUNDLE') return texts.bundle;
  return texts.noForm(analysis.files ?? 0);
}

export function rulesSection(result: ExplorationResult, language: ReportLanguage): string {
  const summary = result.formRules;
  if (!summary) return '';
  const t = TEXTS[language];
  const parts: string[] = [];

  // ---- état des formulaires
  const states = summary.fieldStates.filter((entry) => entry.fields.length > 0);
  if (states.length > 0) {
    const tables = states
      .slice(0, 10)
      .map(
        (entry) =>
          `<h3>${esc(entry.route)}</h3><table><thead><tr>${t.stateColumns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${entry.fields
            .map(
              (field) =>
                `<tr><td>${esc(field.label ? `${field.label} (${field.fieldId})` : field.fieldId)}</td><td>${esc(field.state)}</td><td>${esc(field.origin ? `${field.origin}${field.confidence !== undefined ? ` (${String(Math.round(field.confidence * 100))} %)` : ''}` : '—')}</td><td>${esc(field.source ?? '—')}</td><td><strong>${esc(field.decision)}</strong></td><td class="wrap">${esc(field.reason)}</td></tr>`,
            )
            .join('')}</tbody></table>`,
      )
      .join('');
    parts.push(
      `<section><h2>${esc(t.formState)}</h2><p class="muted">${esc(t.formStateHint)}</p>${tables}</section>`,
    );
  }

  // ---- règles
  const rules = summary.rules;
  if (rules) {
    const coverage = rules.coverage;
    const row = (label: string, value: string | number): string =>
      `<tr><th>${esc(label)}</th><td>${esc(String(value))}</td></tr>`;
    const coverageTable = `<h3>${esc(t.coverage)}</h3><table>${[
      row(t.coverageRows.discovered, coverage.discovered),
      row(t.coverageRows.confirmed, coverage.confirmed),
      row(t.coverageRows.contradicted, coverage.contradicted),
      row(t.coverageRows.partial, coverage.partiallyVerified),
      row(t.coverageRows.notVerified, coverage.notVerified),
      row(
        t.coverageRows.blocked,
        `${String(coverage.blockedByPolicy)} / ${String(coverage.blockedByContext)}`,
      ),
      row(t.coverageRows.inconclusive, coverage.inconclusive),
      row(t.coverageRows.verified, coverage.verified),
      row(t.coverageRows.technical, rules.technicalConditions),
    ].join('')}</table><p class="muted">${esc(t.coverageNote)}</p>`;
    const items = rules.items
      .map((rule) => {
        const color = STATUS_COLOR[rule.status] ?? '#757575';
        const effects = rule.effects
          .map((effect) => `${VERDICT_MARK[effect.verdict] ?? '·'} ${esc(effect.text)}`)
          .join('<br>');
        const detail = (label: string, value: string | undefined): string =>
          value ? `<tr><th>${esc(label)}</th><td class="wrap">${value}</td></tr>` : '';
        return `<details><summary><span class="pill" style="background:${color};color:#fff">${esc(rule.status)}</span> <strong>${esc(rule.name)}</strong> <span class="muted">${esc(rule.category)} · ${esc(rule.coverage)}</span></summary><table>${[
          detail(t.rule, esc(rule.name)),
          detail(t.category, esc(rule.category)),
          detail(t.condition, esc(rule.conditions)),
          detail(t.effects, effects),
          detail(t.source, rule.evidence.map(esc).join('<br>')),
          detail(t.runtime, rule.runtime.length > 0 ? rule.runtime.map(esc).join('<br>') : esc(rule.status)),
          detail(t.network, rule.network.length > 0 ? rule.network.map(esc).join('<br>') : undefined),
          detail(t.confidence, esc(rule.confidence)),
          detail(t.blocked, rule.blockedReason ? esc(rule.blockedReason) : undefined),
          detail(
            t.contradiction,
            rule.contradiction
              ? Object.entries(rule.contradiction)
                  .map(([key, value]) => `${esc(key)}: ${esc(value)}`)
                  .join('<br>')
              : undefined,
          ),
          detail(t.history, rule.history ? esc(rule.history) : undefined),
        ].join('')}</table></details>`;
      })
      .join('');
    const tree = rules.tree
      .map(
        (subject) =>
          `<li><strong>${esc(subject.subject)}</strong><ul>${subject.branches
            .map(
              (branch) =>
                `<li>${esc(branch.when)}<ul>${branch.effects.map((effect) => `<li>${esc(effect)}</li>`).join('')}</ul></li>`,
            )
            .join('')}</ul></li>`,
      )
      .join('');
    const empty = coverage.discovered === 0 ? whyNoRules(result, language) : undefined;
    parts.push(
      `<section><h2>${esc(t.rules)}</h2><p class="muted">${esc(t.rulesHint)}</p>${empty ? `<p><strong>${esc(empty)}</strong></p>` : ''}${coverageTable}${items}<h3>${esc(t.tree)}</h3><ul>${tree}</ul></section>`,
    );
  } else if (summary.rulesEnabled) {
    // Règles activées mais aucune connaissance du code : la section dit pourquoi elle est vide.
    parts.push(
      `<section><h2>${esc(t.rules)}</h2><p><strong>${esc(whyNoRules(result, language))}</strong></p></section>`,
    );
  }

  // ---- dépendances
  if (summary.dependencies.length > 0) {
    const rows = summary.dependencies
      .map(
        (edge) =>
          `<tr><td>${esc(edge.from)}</td><td>${esc(edge.to)}</td><td>${esc(edge.kind)}</td><td>${esc(edge.evidence)}${edge.observations > 0 ? ` (${String(edge.observations)}×)` : ''}</td><td>${esc(edge.triggerValue ? `${edge.from} = ${edge.triggerValue}` : '—')}</td></tr>`,
      )
      .join('');
    parts.push(
      `<section><h2>${esc(t.dependencies)}</h2><table><thead><tr>${t.dependencyColumns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>`,
    );
  }
  return parts.join('');
}
