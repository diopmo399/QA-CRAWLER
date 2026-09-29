import { COVERAGE_STATUSES } from '../coverage/coverage-map.js';
import { renderReason, scoreEquation } from '../decision/score-breakdown.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import { VERDICT_CATEGORIES } from '../oracles/confidence.js';
import { classPill, esc } from './html-common.js';
import { valueLabel, type ReportLanguage } from './i18n.js';
import { engineLabel, translateEngineText } from './engine-text.js';
import { describeGoal } from '../goals/goal-model.js';
import { writePattern } from '../policies/write-guard.js';

/** Textes de la section « Moteur de décision », en anglais et en français. */
const TEXTS = {
  en: {
    title: 'Decision engine',
    hint: 'How the crawler chose what to explore: the goals of the mission and their evidence, the interface patterns recognised, the coverage, and each selected action with the reasons of its score. No machine learning: rules, patterns, graph search, history and coverage.',
    strategy: 'Strategy',
    packs: 'Domain packs',
    knowledge: 'Knowledge base',
    runs: (count: number) => `${count} run(s)`,
    budget: 'Budget used',
    goals: 'Goals',
    goal: 'Goal',
    status: 'Status',
    evidence: 'Evidence',
    noGoal: 'No functional goal in the mission (goals: [users, create-user]…).',
    patterns: 'Interface patterns',
    screen: 'Screen',
    pattern: 'Patterns (confidence) — evidence',
    coverage: 'Coverage',
    states: 'Screens',
    actions: 'Actions',
    forms: 'Forms',
    area: 'Area',
    ratio: 'Covered',
    decisions: 'Selected actions (explained)',
    action: 'Action',
    score: 'Score',
    reasons: 'Reasons',
    more: (count: number) =>
      `… and ${count} more decision(s) in decision-trace.json (logging.decisionTrace: true).`,
    categories: 'Verdict categories',
    categoriesHint:
      'An unusual behaviour is not automatically a bug: each category says how sure the finding is.',
    invariants: 'Invariants',
    invariant: 'Invariant',
    severity: 'Severity',
    expected: 'Expected',
    observed: 'Observed',
    writes: 'Write requests blocked (side effects)',
    writesHint:
      'POST / PUT / PATCH / DELETE sent by an action that was not allowed to change data: cancelled by the write guard (safety.writeGuard).',
    during: 'During',
    request: 'Request',
    properties: 'Property cases (boundaries, partitions)',
    form: 'Form',
    case: 'Case',
    expectation: 'Expected',
    outcome: 'Outcome',
    verdict: 'Verdict',
    historical: 'Historical knowledge (confidence)',
    historicalHint:
      'What past runs taught, and how far it can be trusted: confidence = sample × stability × recency × context. A historical probability is never a functional certainty; old knowledge weighs less but is never deleted.',
    context: 'Current context',
    transitions: 'Transitions known',
    aged: 'Aged (recency < 0.5)',
    otherContext: 'Seen in another context',
    transition: 'Transition',
    destination: 'Usual destination',
    confidence: 'Confidence',
    lastSeen: 'Last seen',
    adaptive: (count: number) =>
      `Adaptive scoring adjusted ${count} decision(s): historical success weighted by its confidence, rarely explored actions, unstable history (factor « adaptive »).`,
  },
  fr: {
    title: 'Moteur de décision',
    hint: 'Comment le crawler a choisi quoi explorer : les objectifs de la mission et leurs preuves, les motifs d’interface reconnus, la couverture, et chaque action choisie avec les raisons de son score. Aucun apprentissage automatique : des règles, des motifs, une recherche dans le graphe, l’historique et la couverture.',
    strategy: 'Stratégie',
    packs: 'Packs de domaine',
    knowledge: 'Base de connaissances',
    runs: (count: number) => `${count} run(s)`,
    budget: 'Budget utilisé',
    goals: 'Objectifs',
    goal: 'Objectif',
    status: 'Statut',
    evidence: 'Preuves',
    noGoal: 'Aucun objectif fonctionnel dans la mission (goals: [users, create-user]…).',
    patterns: 'Motifs d’interface',
    screen: 'Écran',
    pattern: 'Motifs (confiance) — preuves',
    coverage: 'Couverture',
    states: 'Écrans',
    actions: 'Actions',
    forms: 'Formulaires',
    area: 'Zone',
    ratio: 'Couvert',
    decisions: 'Actions choisies (expliquées)',
    action: 'Action',
    score: 'Score',
    reasons: 'Raisons',
    more: (count: number) =>
      `… et ${count} décision(s) de plus dans decision-trace.json (logging.decisionTrace: true).`,
    categories: 'Catégories de verdict',
    categoriesHint:
      'Un comportement inhabituel n’est pas automatiquement un bug : chaque catégorie dit à quel point le constat est sûr.',
    invariants: 'Invariants',
    invariant: 'Invariant',
    severity: 'Gravité',
    expected: 'Attendu',
    observed: 'Observé',
    writes: 'Requêtes d’écriture bloquées (effets de bord)',
    writesHint:
      'POST / PUT / PATCH / DELETE envoyés par une action qui n’avait pas le droit de modifier des données : annulés par la garde d’écriture (safety.writeGuard).',
    during: 'Pendant',
    request: 'Requête',
    properties: 'Cas de propriété (bornes, partitions)',
    form: 'Formulaire',
    case: 'Cas',
    expectation: 'Attendu',
    outcome: 'Résultat',
    verdict: 'Verdict',
    historical: 'Connaissance historique (confiance)',
    historicalHint:
      "Ce que les runs passés ont appris, et à quel point s'y fier : confiance = échantillon × stabilité × récence × contexte. Une probabilité historique n'est jamais une certitude fonctionnelle ; une connaissance ancienne pèse moins mais n'est jamais supprimée.",
    context: 'Contexte courant',
    transitions: 'Transitions connues',
    aged: 'Vieillies (récence < 0,5)',
    otherContext: 'Vues dans un autre contexte',
    transition: 'Transition',
    destination: 'Destination habituelle',
    confidence: 'Confiance',
    lastSeen: 'Vue le',
    adaptive: (count: number) =>
      `Le score adaptatif a nuancé ${count} décision(s) : succès historique pondéré par sa confiance, actions peu explorées, historique instable (facteur « adaptive »).`,
  },
} as const;

/** Nombre de décisions montrées dans le HTML (toutes sont dans decision-trace.json). */
const MAX_DECISIONS = 15;

/** La section « Moteur de décision » du rapport HTML ; vide quand le run n'en a rien produit. */
export function intelligenceSection(
  result: ExplorationResult,
  nameOf: (stateId: string) => string,
  language: ReportLanguage,
): string {
  const intelligence = result.intelligence;
  if (!intelligence) return '';
  const t = TEXTS[language];
  const value = (text: string): string => esc(valueLabel(language, text));
  const tr = (text: string): string => translateEngineText(text, language);
  const parts: string[] = [];

  // ---- résumé
  const budget = Object.entries(intelligence.budget)
    .filter(([, usage]) => usage.max > 0)
    .map(([kind, usage]) => `${engineLabel(kind, language)} ${usage.used}/${usage.max}`)
    .join(' · ');
  const knowledge = intelligence.knowledge;
  parts.push(`<p class="muted">${esc(t.hint)}</p>
    <p><strong>${esc(t.strategy)}</strong> : ${esc(intelligence.strategy)} ·
       <strong>${esc(t.packs)}</strong> : ${esc(intelligence.domainPacks.join(', ') || '—')}
       ${knowledge ? ` · <strong>${esc(t.knowledge)}</strong> : ${esc(knowledge.identity.application)}${knowledge.identity.environment ? ` (${esc(knowledge.identity.environment)})` : ''}, ${esc(t.runs(knowledge.runs))}` : ''}
       ${budget ? `<br><strong>${esc(t.budget)}</strong> : ${esc(budget)}` : ''}</p>`);

  // ---- objectifs
  const goals = intelligence.goals.filter((goal) => goal.kind !== 'mission' || goal.status !== 'PENDING');
  parts.push(`<h3>${esc(t.goals)}</h3>`);
  if (intelligence.goals.length === 0) parts.push(`<p class="muted">${esc(t.noGoal)}</p>`);
  else
    parts.push(
      `<table><tr><th>${esc(t.goal)}</th><th>${esc(t.status)}</th><th>${esc(t.evidence)}</th></tr>${goals
        .map(
          (goal) =>
            `<tr><td>${goal.kind === 'mission' ? `<strong>${esc(goal.id)}</strong>` : `&nbsp;&nbsp;${esc(describeGoal(goal, language))}`}</td><td>${classPill(goal.status, language)}</td><td>${
              goal.evidence.length > 0
                ? goal.evidence
                    .slice(0, 4)
                    .map((entry) => `${esc(engineLabel(entry.kind, language))} : ${esc(tr(entry.value))}`)
                    .join('<br>')
                : esc(tr(goal.reason ?? ''))
            }</td></tr>`,
        )
        .join('')}</table>`,
    );

  // ---- motifs
  const withPatterns = Object.entries(intelligence.patterns).filter(([, patterns]) => patterns.length > 0);
  if (withPatterns.length > 0)
    parts.push(
      `<h3>${esc(t.patterns)}</h3><table><tr><th>${esc(t.screen)}</th><th>${esc(t.pattern)}</th></tr>${withPatterns
        .map(
          ([stateId, patterns]) =>
            `<tr><td>${esc(nameOf(stateId))}</td><td>${patterns
              .map(
                (pattern) =>
                  `<strong>${esc(pattern.type)}</strong> (${Math.round(pattern.confidence * 100)} %) — <span class="muted">${esc(pattern.evidence.map((entry) => tr(entry)).join(', '))}</span>`,
              )
              .join('<br>')}</td></tr>`,
        )
        .join('')}</table>`,
    );

  // ---- couverture
  const { coverage } = intelligence;
  const counts = (label: string, entry: Record<string, number>): string =>
    `<tr><td>${esc(label)}</td>${COVERAGE_STATUSES.map((status) => `<td>${entry[status] ?? 0}</td>`).join('')}</tr>`;
  parts.push(`<h3>${esc(t.coverage)}</h3><table><tr><th></th>${COVERAGE_STATUSES.map((status) => `<th>${value(status)}</th>`).join('')}</tr>
    ${counts(t.states, coverage.states)}${counts(t.actions, coverage.actions)}${counts(t.forms, coverage.forms)}</table>`);
  if (coverage.areas.length > 0)
    parts.push(
      `<table><tr><th>${esc(t.area)}</th><th>${esc(t.ratio)}</th></tr>${coverage.areas
        .map(
          (area) =>
            `<tr><td>/${esc(area.area === '/' ? '' : area.area)}</td><td><div style="background:#e2e8f0;border-radius:4px;width:160px;display:inline-block;vertical-align:middle"><div style="background:#2e7d32;height:8px;border-radius:4px;width:${Math.round(area.ratio * 160)}px"></div></div> ${Math.round(area.ratio * 100)} %</td></tr>`,
        )
        .join('')}</table>`,
    );

  // ---- décisions expliquées
  if (intelligence.decisions.length > 0) {
    const shown = intelligence.decisions.slice(0, MAX_DECISIONS);
    parts.push(
      `<h3>${esc(t.decisions)}</h3><table><tr><th>#</th><th>${esc(t.screen)}</th><th>${esc(t.action)}</th><th>${esc(t.score)}</th><th>${esc(t.reasons)}</th></tr>${shown
        .map(
          (decision, index) =>
            `<tr><td>${index + 1}</td><td>${esc(nameOf(decision.stateId))}</td><td><strong>${esc(decision.label)}</strong></td><td>${decision.score}${decision.breakdown ? `<br><span class="muted">${esc(scoreEquation(decision.breakdown))}</span>` : ''}</td><td>${
              decision.breakdown
                ? decision.breakdown.details
                    .map((reason) => esc(tr(renderReason(reason, language))))
                    .join('<br>')
                : ''
            }</td></tr>`,
        )
        .join('')}</table>`,
    );
    if (intelligence.decisions.length > MAX_DECISIONS)
      parts.push(`<p class="muted">${esc(t.more(intelligence.decisions.length - MAX_DECISIONS))}</p>`);
    const adjusted = intelligence.decisions.filter((decision) => (decision.breakdown?.adaptive ?? 0) !== 0);
    if (adjusted.length > 0) parts.push(`<p class="muted">${esc(t.adaptive(adjusted.length))}</p>`);
  }

  // ---- catégories de verdict
  const byCategory = new Map<string, number>();
  for (const edge of result.transitions)
    for (const category of edge.oracle?.categories ?? [])
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
  if (byCategory.size > 0)
    parts.push(
      `<h3>${esc(t.categories)}</h3><p class="muted">${esc(t.categoriesHint)}</p><table>${VERDICT_CATEGORIES.filter(
        (category) => byCategory.has(category),
      )
        .map(
          (category) =>
            `<tr><td>${classPill(category, language)}</td><td>${byCategory.get(category) ?? 0}</td></tr>`,
        )
        .join('')}</table>`,
    );

  // ---- invariants : un résumé par règle, puis seulement les échecs en détail
  const invariants = result.invariants ?? [];
  if (invariants.length > 0) {
    const byRule = new Map<string, { entry: (typeof invariants)[number]; pass: number; fail: number }>();
    for (const entry of invariants) {
      const rule = byRule.get(entry.invariantId) ?? { entry, pass: 0, fail: 0 };
      if (entry.status === 'FAIL') rule.fail += 1;
      else rule.pass += 1;
      byRule.set(entry.invariantId, rule);
    }
    const failed = invariants.filter((entry) => entry.status === 'FAIL');
    parts.push(
      `<h3>${esc(t.invariants)}</h3><table><tr><th>${esc(t.invariant)}</th><th>${esc(t.severity)}</th><th>PASS</th><th>FAIL</th></tr>${[
        ...byRule.values(),
      ]
        .map(
          ({ entry, pass, fail }) =>
            `<tr><td><strong>${esc(entry.invariantId)}</strong>${entry.description ? `<br><span class="muted">${esc(entry.description)}</span>` : ''}</td><td>${esc(valueLabel(language, entry.severity))}</td><td>${pass}</td><td>${fail > 0 ? classPill('FAIL', language) + ` ${fail}` : '0'}</td></tr>`,
        )
        .join('')}</table>`,
    );
    if (failed.length > 0)
      parts.push(
        `<table><tr><th>${esc(t.invariant)}</th><th>${esc(t.expected)}</th><th>${esc(t.observed)}</th></tr>${failed
          .slice(0, 20)
          .map(
            (entry) =>
              `<tr><td>${classPill('FAIL', language)} <strong>${esc(entry.invariantId)}</strong>${entry.actor ? ` (${esc(entry.actor)})` : ''}</td><td>${esc(tr(entry.expected))}</td><td>${esc(tr(entry.observed))}</td></tr>`,
          )
          .join('')}</table>`,
      );
  }

  // ---- écritures bloquées : regroupées par requête (une par frappe sinon)
  const writes = result.blockedWrites ?? [];
  if (writes.length > 0) {
    const groups = new Map<
      string,
      { method: string; pattern: string; example: string; during: string; count: number }
    >();
    for (const write of writes) {
      const pattern = writePattern(write.url);
      const key = `${write.method} ${pattern} ${write.during}`;
      const group = groups.get(key) ?? {
        method: write.method,
        pattern,
        example: write.url,
        during: write.during,
        count: 0,
      };
      group.count += 1;
      groups.set(key, group);
    }
    parts.push(
      `<h3>${esc(t.writes)}</h3><p class="muted">${esc(t.writesHint)}</p><table><tr><th>${esc(t.request)}</th><th>×</th><th>${esc(t.during)}</th></tr>${[
        ...groups.values(),
      ]
        .slice(0, 30)
        .map(
          (group) =>
            `<tr><td><code>${esc(group.method)} ${esc(group.pattern)}</code><br><span class="muted">${esc(group.example)}</span></td><td>${group.count}</td><td>${esc(tr(group.during))}</td></tr>`,
        )
        .join('')}</table>`,
    );
  }

  // ---- cas de propriété
  const properties = (result.formReports ?? []).flatMap((form) =>
    (form.propertyCases ?? []).map((entry) => ({ form: form.name, ...entry })),
  );
  if (properties.length > 0)
    parts.push(
      `<h3>${esc(t.properties)}</h3><table><tr><th>${esc(t.form)}</th><th>${esc(t.case)}</th><th>${esc(t.expectation)}</th><th>${esc(t.outcome)}</th><th>${esc(t.verdict)}</th></tr>${properties
        .slice(0, 60)
        .map(
          (entry) =>
            `<tr><td>${esc(entry.form)}</td><td>${esc(entry.description)}${entry.message ? `<br><span class="muted">${esc(entry.message)}</span>` : ''}</td><td>${value(entry.expectation)}</td><td>${value(entry.outcome)}</td><td>${classPill(entry.verdict === 'PASS' ? 'PASS' : entry.verdict === 'FAIL' ? 'FAIL' : 'UNKNOWN', language)}</td></tr>`,
        )
        .join('')}</table>`,
    );

  // ---- connaissance historique (ConfidenceEngine)
  const historical = intelligence.historicalKnowledge;
  if (historical) {
    const ctx = historical.context;
    const contextText = [
      ctx.applicationId,
      ctx.environment,
      ctx.actor,
      ctx.version,
      ctx.browser,
      ctx.viewportClass,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ');
    const levels = Object.entries(historical.levels)
      .map(([level, count]) => `${esc(level)} ${count}`)
      .join(' · ');
    parts.push(`<h3>${esc(t.historical)}</h3><p class="muted">${esc(t.historicalHint)}</p>
      <p><strong>${esc(t.context)}</strong> : ${esc(contextText)}<br>
         <strong>${esc(t.transitions)}</strong> : ${historical.transitions} · ${levels}<br>
         <strong>${esc(t.aged)}</strong> : ${historical.aged} · <strong>${esc(t.otherContext)}</strong> : ${historical.otherContext}</p>`);
    if (historical.entries.length > 0)
      parts.push(
        `<table><tr><th>${esc(t.transition)}</th><th>${esc(t.destination)}</th><th>${esc(t.confidence)}</th><th>${esc(t.reasons)}</th><th>${esc(t.lastSeen)}</th></tr>${historical.entries
          .map(
            (entry) =>
              `<tr><td>${esc(entry.fromStateSignature)}<br><span class="muted">${esc(entry.actionSignature)}</span></td><td>${entry.dominantTarget ? `${esc(entry.dominantTarget)} (${Math.round(entry.dominantShare * 100)} %)` : '—'}</td><td>${entry.confidence.score} ${esc(entry.confidence.level)}</td><td>${entry.confidence.reasons
                .map((reason) => `${esc(reason.factor)} ${reason.value} — ${esc(reason.detail)}`)
                .join('<br>')}</td><td>${esc(entry.lastSeenAt.slice(0, 10))}</td></tr>`,
          )
          .join('')}</table>`,
      );
  }

  return `<section><h2>${esc(t.title)}</h2>${parts.join('\n')}</section>`;
}
