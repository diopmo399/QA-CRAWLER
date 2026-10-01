import type { ExplorationResult } from '../model/exploration-result.js';
import { esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/**
 * Section « Intelligence fonctionnelle » : machines à états métier, workflows,
 * invariants, effets secondaires, chemins d'erreur, observations de contrat, objectifs
 * de test et couverture fonctionnelle. Des décomptes et des preuves — JAMAIS une note de
 * qualité. Aucune valeur saisie.
 */
const TEXTS = {
  en: {
    title: 'Functional intelligence',
    hint: 'Static suggests. History guides. Runtime confirms. Safety decides. Counts and evidence, never a quality grade.',
    coverage: 'Functional coverage',
    coverageRows: {
      rules: 'Rules verified',
      states: 'Business states observed',
      transitions: 'Transitions confirmed',
      contradicted: 'Transitions contradicted',
      invariants: 'Invariants confirmed',
      violated: 'Invariants violated',
      workflows: 'Workflows verified',
      effects: 'Side effects confirmed',
      missing: 'Side effects missing',
      errors: 'Error paths observed',
      contract: 'Write operations checked against the contract',
      mismatches: 'Contract observations',
    },
    machines: 'Business state machines',
    transitionColumns: ['From', 'To', 'Trigger', 'API', 'Status', 'Evidence'],
    forbidden: 'Transitions not offered',
    workflows: 'Workflows',
    workflowColumns: ['Signature', 'Steps', 'Expected', 'Status', 'Last observation'],
    invariants: 'Invariants',
    invariantColumns: ['Scope', 'Assertion', 'Status', 'Source'],
    effects: 'Side effects',
    effectColumns: ['Action', 'Category', 'Expected effect', 'Status'],
    errors: 'Error paths',
    errorColumns: ['Operation', 'HTTP', 'Class', 'Business code', 'UI', 'Status'],
    contract: 'Contract observations (CONTRACT_MISMATCH, not application bugs)',
    contractColumns: ['Kind', 'Operation', 'Field', 'Detail'],
    goals: 'Test goals',
    goalColumns: ['Goal', 'Category', 'Priority', 'Cost', 'Risk', 'Status', 'Why', 'Plan / outcome'],
    deferred: 'goal(s) deferred by maxGoalsPerRun',
  },
  fr: {
    title: 'Intelligence fonctionnelle',
    hint: 'Le code suggère, l’historique guide, l’exécution confirme, la sécurité décide. Des décomptes et des preuves, jamais une note de qualité.',
    coverage: 'Couverture fonctionnelle',
    coverageRows: {
      rules: 'Règles vérifiées',
      states: 'États métier observés',
      transitions: 'Transitions confirmées',
      contradicted: 'Transitions contredites',
      invariants: 'Invariants confirmés',
      violated: 'Invariants violés',
      workflows: 'Workflows vérifiés',
      effects: 'Effets confirmés',
      missing: 'Effets manquants',
      errors: 'Chemins d’erreur observés',
      contract: 'Écritures comparées au contrat',
      mismatches: 'Observations de contrat',
    },
    machines: 'Machines à états métier',
    transitionColumns: ['De', 'Vers', 'Déclencheur', 'API', 'Statut', 'Preuves'],
    forbidden: 'Transitions non offertes',
    workflows: 'Workflows',
    workflowColumns: ['Signature', 'Étapes', 'Attendu', 'Statut', 'Dernière observation'],
    invariants: 'Invariants',
    invariantColumns: ['Portée', 'Assertion', 'Statut', 'Source'],
    effects: 'Effets secondaires',
    effectColumns: ['Action', 'Catégorie', 'Effet attendu', 'Statut'],
    errors: 'Chemins d’erreur',
    errorColumns: ['Opération', 'HTTP', 'Classe', 'Code métier', 'Interface', 'Statut'],
    contract: 'Observations de contrat (CONTRACT_MISMATCH, pas des bugs de l’application)',
    contractColumns: ['Genre', 'Opération', 'Champ', 'Détail'],
    goals: 'Objectifs de test',
    goalColumns: [
      'Objectif',
      'Catégorie',
      'Priorité',
      'Coût',
      'Risque',
      'Statut',
      'Pourquoi',
      'Plan / issue',
    ],
    deferred: 'objectif(s) reporté(s) par maxGoalsPerRun',
  },
} as const;

const COLOR: Record<string, string> = {
  RUNTIME_CONFIRMED: '#2e7d32',
  CONFIRMED: '#2e7d32',
  VERIFIED: '#2e7d32',
  RUNTIME_CONTRADICTED: '#c62828',
  RUNTIME_VIOLATED: '#c62828',
  MISSING: '#c62828',
  FAILED: '#c62828',
  BLOCKED: '#6a1b9a',
  RUNTIME_OBSERVED: '#1565c0',
  OBSERVED: '#1565c0',
  RUNNING: '#1565c0',
  PLANNED: '#1565c0',
  PARTIALLY_VERIFIED: '#1565c0',
  INCONCLUSIVE: '#6d4c41',
};

function badge(status: string): string {
  return `<strong style="color:${COLOR[status] ?? '#757575'}">${esc(status)}</strong>`;
}

function table(columns: readonly string[], rows: string[][]): string {
  return `<table><thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td class="wrap">${cell}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

export function functionalSection(result: ExplorationResult, language: ReportLanguage): string {
  const summary = result.functional;
  if (!summary) return '';
  const t = TEXTS[language];
  const c = summary.coverage;
  const ratio = (done: number, total: number): string => `${String(done)} / ${String(total)}`;
  const parts: string[] = [];
  const rows = t.coverageRows;
  parts.push(
    `<h3>${esc(t.coverage)}</h3>${table(
      ['', ''],
      [
        [esc(rows.rules), esc(ratio(c.rules.verified, c.rules.total))],
        [esc(rows.states), esc(ratio(c.states.observed, c.states.total))],
        [esc(rows.transitions), esc(ratio(c.transitions.confirmed, c.transitions.total))],
        [esc(rows.contradicted), esc(String(c.transitions.contradicted))],
        [esc(rows.invariants), esc(ratio(c.invariants.confirmed, c.invariants.total))],
        [esc(rows.violated), esc(String(c.invariants.violated))],
        [esc(rows.workflows), esc(ratio(c.workflows.verified, c.workflows.total))],
        [esc(rows.effects), esc(ratio(c.sideEffects.confirmed, c.sideEffects.total))],
        [esc(rows.missing), esc(String(c.sideEffects.missing))],
        [esc(rows.errors), esc(ratio(c.errorPaths.observed, c.errorPaths.total))],
        [esc(rows.contract), esc(ratio(c.contract.checked, c.contract.operations))],
        [esc(rows.mismatches), esc(String(c.contract.mismatches))],
      ],
    )}`,
  );
  for (const machine of summary.machines) {
    parts.push(
      `<h3>${esc(t.machines)}: ${esc(machine.entityType)} (${esc(machine.stateField)})</h3><p>${machine.states
        .map((state) => `<code>${esc(state.state)}</code>${state.observed ? ' ✓' : ''}`)
        .join(' · ')}</p>${table(
        t.transitionColumns,
        machine.transitions.map((transition) => [
          esc(transition.from),
          esc(transition.to),
          esc(
            `${transition.trigger ?? ''}${transition.triggerLabel ? ` ("${transition.triggerLabel}")` : ''}`,
          ),
          esc(transition.api ?? '—'),
          `${badge(transition.status)}${transition.historical ? ' <span class="muted">(earlier run)</span>' : ''}`,
          esc(
            transition.evidence
              .slice(-2)
              .map(
                (entry) =>
                  `${entry.provenance?.location ? `${entry.provenance.location.file}:${String(entry.provenance.location.line)} ` : ''}${entry.value}`,
              )
              .join(' | '),
          ),
        ]),
      )}${
        machine.forbidden.length > 0
          ? `<p class="muted">${esc(t.forbidden)}: ${machine.forbidden
              .slice(0, 20)
              .map((entry) => `${esc(entry.from)} ✗ ${esc(entry.trigger)} ${badge(entry.status)}`)
              .join(' · ')}</p>`
          : ''
      }`,
    );
  }
  if (summary.workflows.length > 0)
    parts.push(
      `<h3>${esc(t.workflows)}</h3>${table(
        t.workflowColumns,
        summary.workflows.map((workflow) => [
          `<code>${esc(workflow.id)}</code>`,
          esc(workflow.steps.map((step) => step.description).join(' → ')),
          esc(workflow.expectedOutcomes.map((outcome) => outcome.description).join('; ')),
          badge(workflow.status),
          esc(workflow.observations?.at(-1) ?? '—'),
        ]),
      )}`,
    );
  if (summary.invariants.length > 0)
    parts.push(
      `<h3>${esc(t.invariants)}</h3>${table(
        t.invariantColumns,
        summary.invariants.map((invariant) => [
          esc(invariant.scope),
          `<code>${esc(invariant.assertion.text)}</code>`,
          badge(invariant.status),
          esc(invariant.evidence[0]?.value ?? '—'),
        ]),
      )}`,
    );
  if (summary.sideEffects.length > 0)
    parts.push(
      `<h3>${esc(t.effects)}</h3>${table(
        t.effectColumns,
        summary.sideEffects.map((effect) => [
          esc(effect.actionIntent),
          esc(effect.category),
          esc(effect.expectedEffect),
          badge(effect.status),
        ]),
      )}`,
    );
  if (summary.errorPaths.length > 0)
    parts.push(
      `<h3>${esc(t.errors)}</h3>${table(
        t.errorColumns,
        summary.errorPaths.map((path) => [
          esc(path.operation),
          esc(path.httpStatus !== undefined ? String(path.httpStatus) : '—'),
          esc(path.errorClass),
          esc(path.businessCode ?? '—'),
          esc(
            `${path.uiResult}${path.uiTarget ? ` → ${path.uiTarget}` : ''}${path.uiMessage ? ` « ${path.uiMessage} »` : ''}`,
          ),
          badge(path.status),
        ]),
      )}`,
    );
  if (summary.contract.length > 0)
    parts.push(
      `<h3>${esc(t.contract)}</h3>${table(
        t.contractColumns,
        summary.contract.map((entry) => [
          esc(entry.kind),
          esc(entry.operation),
          esc(entry.field ?? '—'),
          esc(entry.detail),
        ]),
      )}`,
    );
  if (summary.goals.length > 0)
    parts.push(
      `<h3>${esc(t.goals)}</h3>${table(
        t.goalColumns,
        summary.goals.map((goal) => [
          esc(goal.intent),
          esc(goal.category),
          esc(String(goal.priority)),
          esc(String(goal.estimatedCost)),
          esc(goal.risk >= 1 ? 'HIGH' : goal.risk > 0 ? 'MEDIUM' : 'LOW'),
          badge(goal.status),
          esc(`${goal.reason ?? ''} — ${goal.generatedFrom}`),
          esc(
            goal.plan
              ? `${goal.plan.strategy}: ${goal.plan.explanation}`
              : (goal.observations?.at(-1) ?? '—'),
          ),
        ]),
      )}${summary.deferredGoals > 0 ? `<p class="muted">${String(summary.deferredGoals)} ${esc(t.deferred)}</p>` : ''}`,
    );
  return `<section><h2>${esc(t.title)}</h2><p class="muted">${esc(t.hint)}</p>${parts.join('')}</section>`;
}
