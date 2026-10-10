import { BASE_CSS, card, esc } from '../reporting/html-common.js';
import { describeStep } from '../config/flow-schema.js';
import type { RawRecordedEvent, SemanticRecordedAction } from './model.js';
import type { RecordingIntelligence } from './recording-intelligence.js';
import type { SemanticAuditReport, SemanticInterpretation } from './semantic-audit.js';
import type { RecordingResult } from './process-recording.js';
import type { RecordingTargetValidation } from './target-validator.js';

export type ReplayStatus = 'REPLAY_CONFIRMED' | 'REPLAY_FAILED' | 'NOT_VALIDATED';

export interface ReplayOutcome {
  status: ReplayStatus;
  /** Statut du dry run qui a rejoué le flow (FULLY_MATCHED…). */
  dryRunStatus?: string;
  reason?: string;
  report?: string;
  /** Chaque étape rejouée (position dans le flow, résultat, raisons) : la revue dit laquelle a échoué. */
  steps?: { index: number; label: string; outcome: string; reasons: string[]; evidence: string[] }[];
}

const REPLAY_COLORS: Record<ReplayStatus, string> = {
  REPLAY_CONFIRMED: '#15803d',
  REPLAY_FAILED: '#dc2626',
  NOT_VALIDATED: '#64748b',
};

/**
 * Le rapport d'un enregistrement : le résumé (comptes, sans aucune note), la trace
 * RAW → SEMANTIC → FINAL (pourquoi chaque étape existe, ce qui a été écarté et
 * pourquoi), les vérifications proposées avec leur stabilité, et les fichiers.
 * Jamais une saisie : seulement des formes, des libellés et des clés de données de test.
 */
export function recordingHtml(input: {
  result: RecordingResult;
  replay: ReplayOutcome;
  files: Record<string, string>;
  generatedAt: string;
  intelligence?: RecordingIntelligence;
  audit?: SemanticAuditReport;
}): string {
  const { result, replay } = input;
  const { session, normalized, flow } = result;
  const q = flow.quality;
  const kept = normalized.kept.length;
  const cards = [
    card('Raw events', session.rawEvents.length),
    card('Semantic actions', normalized.actions.length),
    card('Kept actions', kept),
    card('Final steps', flow.steps.length, '#2563eb'),
    card('Noise removed', q.removedNoise),
    card('Inputs merged', q.mergedInputs),
    card('Corrections collapsed', q.collapsedCorrections),
    card('Detours removed', q.removedDetours),
    card('Assertions selected', q.assertions.selected, '#15803d'),
    card('Fragile assertions (review)', q.assertions.fragile, '#b45309'),
    card('Ambiguous targets', q.ambiguousTargets, '#b45309'),
    card('Fragile locators', q.fragileLocators, '#b45309'),
    card('Secrets redacted', q.sensitiveRedacted),
    card('Dropped events (buffer)', session.droppedEvents, '#b45309'),
  ].join('');
  const locators = Object.entries(q.locators)
    .filter(([, count]) => count > 0)
    .map(([quality, count]) => `<li><b>${esc(quality)}</b>: ${String(count)}</li>`)
    .join('');
  const values = Object.entries(q.values)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `<li><b>${esc(kind)}</b>: ${String(count)}</li>`)
    .join('');
  const rawById = new Map(session.rawEvents.map((event) => [event.id, event]));
  const stepsByAction = new Map<string, string[]>();
  for (const step of flow.steps)
    for (const id of step.actionIds)
      stepsByAction.set(id, [
        ...(stepsByAction.get(id) ?? []),
        `${step.id} ${describeStep(step.step, true)}`,
      ]);
  const trace = normalized.actions.map((action) => traceRow(action, rawById, stepsByAction)).join('');
  const assertions = flow.assertions
    .map(
      (candidate) =>
        `<tr><td>${esc(candidate.kind)}</td><td>${esc(candidate.description)}</td><td>${esc(candidate.stability)}</td><td>${candidate.confidence.toFixed(2)}</td><td>${candidate.selected ? '✓ in the flow' : 'review'}</td><td class="muted">${esc(candidate.reason)} · ${esc(candidate.provenance)}</td></tr>`,
    )
    .join('');
  const warnings = result.warnings
    .map((warning) => `<li><b>${esc(warning.code)}</b> ${esc(warning.message)}</li>`)
    .join('');
  const steps = flow.steps
    .map(
      (step) =>
        `<li><code>${esc(describeStep(step.step, true))}</code> <span class="muted">${esc(step.provenance)} · ${esc(step.explanation)} · raw ${esc(step.rawEventIds.join(', '))}</span></li>`,
    )
    .join('');
  const checkpoints = session.checkpoints
    .map(
      (checkpoint) =>
        `<li><b>${esc(checkpoint.label)}</b>${checkpoint.state ? ` on ${esc(checkpoint.state.route)}` : ''} · ${String(checkpoint.assertions.length)} assertion(s)</li>`,
    )
    .join('');
  const files = Object.entries(input.files)
    .map(([label, file]) => `<li><a href="${esc(file)}">${esc(label)}</a></li>`)
    .join('');
  const intent = flow.intent;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(flow.name)} — recording</title>
<style>${BASE_CSS}${CSS}</style></head>
<body>
<header class="rec-head"><div class="wrap">
  <div class="kicker">QA-CRAWLER · HUMAN FLOW RECORDER · ${esc(session.id)}</div>
  <h1>${esc(flow.name)}</h1>
  <div class="status" style="--c:${REPLAY_COLORS[replay.status]}">${esc(replay.status)}</div>
  <p class="sub">A human demonstration turned into an imposed flow: raw events → semantic actions → clean flow (flow.yaml and .feature from the same model). Typed values are never recorded.</p>
</div></header>
<main class="wrap">
  <section><h2>Summary</h2><div class="cards">${cards}</div>
    <p class="muted">Start ${esc(session.startUrl)} · ${esc(session.startedAt)} → ${esc(session.endedAt ?? '')}${session.environment ? ` · environment ${esc(session.environment)}` : ''}${session.version ? ` · version ${esc(session.version)}` : ''}${session.role ? ` · role ${esc(session.role)}` : ''}</p>
    ${replay.reason ? `<p class="muted">Replay: ${esc(replay.reason)}${replay.report ? ` · <a href="${esc(replay.report)}">dry run report</a>` : ''}</p>` : ''}
  </section>
  <section><h2>Semantic intent (post-recording layer)</h2>
    <p class="muted">Inferred after the recording from the observed requests (semantic-intents.json); it never changes the recorded steps.</p>
    <p>${intent.workflow ? `<b>${esc(intent.workflow)}</b>${intent.api ? ` · ${esc(intent.api)}` : ''}` : 'No business write observed.'}${flow.negative ? ' · <b>negative validation flow</b>' : ''}</p>
    ${intent.transitions.length > 0 ? `<ul class="plain">${intent.transitions.map((transition) => `<li>${esc(transition.entity)}: ${esc(transition.from)} → ${esc(transition.to)}</li>`).join('')}</ul>` : ''}
    ${intent.evidence.length > 0 ? `<p class="muted">${esc(intent.evidence.join(' · '))}</p>` : ''}
    ${searchesHtml(result)}
  </section>
  <section><h2>Quality</h2>
    <div class="cols"><div><h3>Locators</h3><ul class="plain">${locators || '<li class="muted">none</li>'}</ul></div>
    <div><h3>Values</h3><ul class="plain">${values || '<li class="muted">none</li>'}</ul></div></div>
    <p class="muted">Facts to judge, not a grade: a FRAGILE locator or an ambiguous target is worth a look before the flow goes into the suite.</p>
  </section>
  ${warnings ? `<section><h2>Warnings</h2><ul class="plain">${warnings}</ul></section>` : ''}
  ${journeySection(result)}
  ${causalitySection(result)}
  ${testDataSection(result)}
  <section><h2>Final flow</h2><ol class="plain">${steps}</ol></section>
  <section><h2>Trace: RAW → SEMANTIC → FINAL</h2>
    <table class="rec"><thead><tr><th>Semantic action</th><th>Raw events</th><th>Kept</th><th>Final step(s)</th><th>Why</th></tr></thead>
    <tbody>${trace}</tbody></table>
    <p class="muted">Nothing is deleted: an action left out keeps its reason. Raw events are in raw-recording.json, semantic actions in semantic-recording.json.</p>
  </section>
  <section><h2>Assertion candidates</h2>
    <table class="rec"><thead><tr><th>Kind</th><th>Assertion</th><th>Stability</th><th>Confidence</th><th>Use</th><th>Why</th></tr></thead>
    <tbody>${assertions || '<tr><td colspan="6" class="muted">none</td></tr>'}</tbody></table>
  </section>
  ${checkpoints ? `<section><h2>Checkpoints</h2><ul class="plain">${checkpoints}</ul></section>` : ''}
  ${input.intelligence ? recordingIntelligenceHtml(input.intelligence) : ''}
  ${targetValidationHtml(result)}
  ${input.audit ? recordingAuditHtml(input.audit) : ''}
  <section><h2>Files</h2><ul class="plain">${files}</ul></section>
  <p class="muted">Generated ${esc(input.generatedAt)}</p>
</main></body></html>
`;
}

function traceRow(
  action: SemanticRecordedAction,
  raw: Map<string, RawRecordedEvent>,
  steps: Map<string, string[]>,
): string {
  const events = action.rawEventIds
    .map((id) => {
      const event = raw.get(id);
      return event
        ? `${id} ${event.type}${event.element ? ` ${event.element.role || event.element.tag} "${event.element.name}"` : ''}`
        : id;
    })
    .join('<br>');
  const label = `${action.type} ${action.target?.label ?? action.route ?? ''}${action.option !== undefined ? ` = "${action.option}"` : ''}${action.value?.testData ? ` = testData.${action.value.testData}` : ''}${action.value?.env ? ` = env.${action.value.env}` : ''}`;
  const why = [
    ...(action.dropped ? [`left out: ${action.dropped}`] : []),
    ...(action.merged ? [`normalized: ${action.merged}`] : []),
    ...(action.target
      ? [
          `${action.target.quality}${action.target.ambiguous ? ' (ambiguous)' : ''}: ${action.target.reasons.join('; ')}`,
        ]
      : []),
    ...(action.value ? [`${action.value.class}: ${action.value.reason}`] : []),
    ...(action.checkpoint !== undefined ? [`checkpoint "${action.checkpoint}"`] : []),
    ...action.network.map(
      (exchange) => `${exchange.method} ${exchange.path} → ${String(exchange.status ?? '…')}`,
    ),
  ];
  return `<tr class="${action.dropped ? 'dropped' : ''}"><td><b>${esc(label)}</b><div class="muted">${esc(action.provenance)} · ${action.confidence.toFixed(2)}</div></td><td class="muted">${events
    .split('<br>')
    .map(esc)
    .join(
      '<br>',
    )}</td><td>${action.dropped ? '—' : '✓'}</td><td>${(steps.get(action.id) ?? []).map(esc).join('<br>')}</td><td class="muted">${why.map(esc).join('<br>')}</td></tr>`;
}

const CSS = `
  .wrap { max-width:1180px; margin:0 auto; padding:0 20px; }
  .rec-head { background:linear-gradient(135deg,var(--head-from),var(--head-to)); color:#fff; padding:28px 0 22px; margin-bottom:22px; }
  .rec-head h1 { margin:6px 0 10px; font-size:26px; }
  .rec-head .kicker { font-size:12px; letter-spacing:.08em; opacity:.8; }
  .rec-head .sub { opacity:.85; margin:10px 0 0; }
  .status { display:inline-block; background:var(--c); color:#fff; font-weight:700; padding:4px 12px; border-radius:999px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:16px 18px; margin-bottom:18px; }
  section h2 { margin:0 0 12px; font-size:17px; }
  section h3 { margin:0 0 6px; font-size:14px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; }
  .muted { color:var(--muted); font-size:12px; }
  table.rec { width:100%; border-collapse:collapse; }
  table.rec th { text-align:left; font-size:12px; color:var(--muted); border-bottom:1px solid var(--line); padding:6px 8px; }
  table.rec td { padding:7px 8px; border-bottom:1px solid var(--soft-line); vertical-align:top; font-size:13px; }
  tr.dropped td { opacity:.6; }
  ol.plain, ul.plain { margin:0; padding-left:22px; }
  ol.plain li, ul.plain li { margin:3px 0; }
`;

/**
 * Human journey : le parcours enseigné, interaction par interaction (statut, étape du flow,
 * effets, donnée de test), les dépendances, les phases, et les interactions non représentées
 * avec leur raison. « Lost without explanation » doit valoir 0.
 */
function journeySection(result: RecordingResult): string {
  const { journey } = result;
  const summary = journey.summary;
  const cards = [
    card('Recorded meaningful interactions', summary.meaningful),
    card('Preserved as flow actions', summary.preserved, '#15803d'),
    card('Unresolved but preserved', summary.unresolvedPreserved, '#b45309'),
    card('Merged', summary.merged),
    card('Excluded with a reason', summary.excluded),
    card('Confirmed noise', summary.noise),
    card('Lost without explanation', summary.unaccounted, summary.unaccounted > 0 ? '#dc2626' : '#15803d'),
  ].join('');
  const color = (status: string): string =>
    status === 'PRESERVED'
      ? '#15803d'
      : status === 'UNRESOLVED_BUT_PRESERVED'
        ? '#b45309'
        : status === 'UNACCOUNTED'
          ? '#dc2626'
          : '#6b7280';
  const timeline = journey.accounts
    .map(
      (account) =>
        `<li><span class="muted">${String(account.sequence).padStart(2, '0')}</span> <b>${esc(account.type)}</b> ${esc(account.target ?? '')} <span style="color:${color(account.status)}">${esc(account.status)}</span>${account.flowStep !== undefined ? ` <span class="muted">→ step ${String(account.flowStep)}</span>` : ''}${account.mergedInto ? ` <span class="muted">→ ${esc(account.mergedInto)}</span>` : ''}${account.effects ? ` <span class="muted">(${account.effects.map(esc).join(', ')})</span>` : ''}${account.testData ? ` <code>testData.${esc(account.testData)}</code>` : ''}</li>`,
    )
    .join('');
  const labelOf = new Map(
    result.normalized.actions.map((action) => [action.id, action.target?.label ?? action.type]),
  );
  const dependencies = journey.dependencies
    .map(
      (dependency) =>
        `<li>${esc(labelOf.get(dependency.from) ?? dependency.from)} → ${esc(labelOf.get(dependency.to) ?? dependency.to)} <span class="muted">(${esc(dependency.evidence)}: ${esc(dependency.reason)})</span></li>`,
    )
    .join('');
  const phases = journey.phases
    .map(
      (phase) =>
        `<li>Phase ${String(phase.index)} — ${esc(phase.label)} <span class="muted">(${phase.interactionIds.join(', ')})</span></li>`,
    )
    .join('');
  const notInFlow = journey.accounts
    .filter((account) => account.flowStep === undefined)
    .map(
      (account) =>
        `<tr><td>${esc(account.interactionId)}</td><td>${esc(account.type)} ${esc(account.target ?? '')}</td><td>${esc(account.status)}</td><td>${esc(account.rule ?? '')}</td><td>${esc(account.mergedInto ?? '')}</td><td class="muted">${esc(account.reason ?? '')} <span class="muted">raw ${account.rawEventIds.join(',')}</span></td></tr>`,
    )
    .join('');
  return `<section><h2>Human journey</h2><div class="cards">${cards}</div>
    <p class="muted">Fidelity ${esc(result.fidelity)} · ${journey.ordered ? 'flow steps in the human order' : '<b>flow steps reordered</b>'} · preserve first, understand second, optimize last.</p>
    <ol class="journey" style="list-style:none;padding-left:0">${timeline}</ol>
    ${dependencies ? `<h3>Dependencies between actions</h3><ul>${dependencies}</ul>` : ''}
    ${phases ? `<h3>Workflow phases</h3><ul>${phases}</ul>` : ''}
    ${notInFlow ? `<h3>Dropped / merged human actions</h3><table class="rec"><thead><tr><th>Interaction</th><th>Action</th><th>Status</th><th>Rule</th><th>Merged into</th><th>Reason</th></tr></thead><tbody>${notInFlow}</tbody></table>` : ''}
    ${result.optimized ? `<p class="muted">FlowOptimizer: optimized.flow.yaml has ${String(result.optimized.flow.steps.length)} step(s) (${result.optimized.removed.map((item) => `${esc(item.label)}: ${esc(item.reason)}`).join('; ') || 'nothing removed'}); generated.flow.yaml keeps the human journey.</p>` : ''}</section>`;
}

/**
 * Recorded test data : chaque donnée, sa clé, sa stratégie et pourquoi. Le rapport ne montre
 * AUCUNE valeur (elles ne sont que dans test-data.yaml, et jamais pour un secret).
 */
function testDataSection(result: RecordingResult): string {
  const data = result.testData;
  if (!data)
    return `<section><h2>Recorded test data</h2><p class="muted">Off (recording.testData.enabled: false): typed values are { testData } chosen at replay.</p></section>`;
  const count = (strategy: string): number => data.items.filter((item) => item.strategy === strategy).length;
  const cards = [
    card('Recorded', count('RECORDED_LITERAL')),
    card('Generated at replay', count('GENERATE_AT_REPLAY') + count('TEMPLATE')),
    card(
      'Business literals',
      count('BUSINESS_LITERAL') +
        data.items.filter(
          (item) => item.classification === 'BUSINESS_LITERAL' && item.strategy === 'FLOW_STEP',
        ).length,
    ),
    card('References', count('REFERENCE')),
    card('Preserved / derived', count('PRESERVE_EXISTING') + count('IGNORE_DERIVED')),
    card('Sensitive recorded values', data.security.sensitiveRecorded),
    card('Converted to credential references', data.security.credentialReferences, '#15803d'),
    card(
      'Clear-text sensitive values persisted',
      data.security.clearTextPersisted,
      data.security.clearTextPersisted > 0 ? '#dc2626' : '#15803d',
    ),
  ].join('');
  const rows = data.items
    .map(
      (item) =>
        `<tr><td>${esc(item.field)}</td><td>${item.key ? `<code>testData.${esc(item.key)}</code>` : '<span class="muted">—</span>'}</td><td>${esc(item.semanticType ?? '')}</td><td>${esc(item.classification)}</td><td>${esc(item.strategy)}${item.detail ? ` <span class="muted">(${esc(item.detail)})</span>` : ''}</td><td class="muted">${item.reasons.map(esc).join('<br>')}</td></tr>`,
    )
    .join('');
  return `<section><h2>Recorded test data</h2><div class="cards">${cards}</div>
    <table class="rec"><thead><tr><th>Field</th><th>Test data</th><th>Semantic type</th><th>Classification</th><th>Replay strategy</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">The flow says what to do, test-data.yaml says with which data (the .feature and the flow use the same file). Recorded values are examples of the test intent: business values keep the meaning of the scenario, generated values keep it replayable, secrets are never written. No value is shown here.</p></section>`;
}

/** Navigation causality : chaque navigation, l'action qui l'a causée, ou pourquoi elle reste un goto. */
function causalitySection(result: RecordingResult): string {
  const correlation = result.correlation;
  const preservation = result.preservation;
  if (!correlation)
    return `<section><h2>Navigation causality</h2><p class="muted">Action correlation is off (recording.actionCorrelation.enabled: false).</p></section>`;
  const raw = new Map(result.session.rawEvents.map((event) => [event.id, event]));
  const reasons = new Map<string, number>();
  for (const decision of correlation.navigations)
    if (decision.kind === 'GOTO' && decision.gotoReason)
      reasons.set(decision.gotoReason, (reasons.get(decision.gotoReason) ?? 0) + 1);
  const cards = [
    card('Navigations observed', correlation.stats.navigations),
    card('Correlated to human actions', correlation.stats.correlated, '#15803d'),
    card('Redirects', correlation.stats.redirects),
    card('Goto (incl. start)', correlation.stats.gotos),
    card('Human clicks', preservation.humanTriggers),
    card('Click steps', preservation.generatedClicks),
    card('Goto steps', preservation.generatedGotos, '#b45309'),
    card('Data-changing actions lost', preservation.lostMutations.length, '#dc2626'),
  ].join('');
  const rows = correlation.navigations
    .map((decision) => {
      const cause = decision.causedBy ? raw.get(decision.causedBy) : undefined;
      const by =
        decision.kind === 'EFFECT'
          ? `${cause?.type ?? ''} "${cause?.element?.name ?? cause?.key ?? ''}" (${decision.causedBy ?? ''})`
          : decision.kind === 'REDIRECT'
            ? `redirect after ${decision.causedBy ?? ''}`
            : decision.kind === 'RELOAD'
              ? 'same page'
              : `goto: ${decision.gotoReason ?? ''}`;
      return `<tr><td>${esc(decision.navigationId)}</td><td>${esc(decision.route)}</td><td>${esc(decision.kind)}</td><td>${esc(by)}</td><td>${esc(decision.confidence ?? '')}${decision.ambiguous ? ' (ambiguous)' : ''}</td><td class="muted">${decision.reasons.map(esc).join('<br>')}</td></tr>`;
    })
    .join('');
  return `<section><h2>Navigation causality</h2><div class="cards">${cards}</div>
    ${reasons.size > 0 ? `<p class="muted">Goto reasons: ${[...reasons].map(([reason, count]) => `${esc(reason)}: ${String(count)}`).join(' · ')}</p>` : ''}
    <table class="rec"><thead><tr><th>Raw</th><th>Route</th><th>Kind</th><th>Caused by / why a goto</th><th>Confidence</th><th>Reasons</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">A navigation that follows a human action is first its effect: the action stays the step, the route becomes an outcome. A goto is generated only when no reliable human cause exists, always with its reason.</p></section>`;
}

/**
 * RECORDING INTELLIGENCE (§42) : les actions humaines (toutes préservées), les appels au
 * conseiller, et ce qu'il propose — des CANDIDATS, en attente de confirmation au rejeu.
 */
function recordingIntelligenceHtml(intelligence: RecordingIntelligence): string {
  const s = intelligence.summary;
  const rows: [string, string][] = [
    ['Mode', intelligence.mode],
    ['Human actions', String(intelligence.humanActions)],
    [
      'Preserved',
      `${String(intelligence.preserved)}${intelligence.preservationVerified ? ' (fingerprint unchanged by the enrichment)' : ' — PRESERVATION CHECK FAILED'}`,
    ],
    ['Ambiguities', intelligence.ambiguities.join(' · ') || 'none (deterministic enrichment only)'],
    ['AI enrichment calls', String(intelligence.aiCalls)],
    ['Functional goals proposed', String(s.functionalGoals)],
    ['Workflow phases', String(s.phases)],
    ['Preconditions proposed', String(s.preconditions)],
    ['Causal hypotheses proposed', String(s.causalHypotheses)],
    ['Semantic checkpoints', String(s.checkpoints)],
    ['Runtime confirmed', String(s.runtimeConfirmed)],
    ['Pending confirmation (AI proposals)', String(s.pendingConfirmation)],
  ];
  const candidates = intelligence.candidates
    .map(
      (candidate) =>
        `<li><b>${esc(candidate.kind)}</b> ${esc(candidate.statement)} <span class="muted">— ${esc(candidate.origin)}${candidate.aiDecisionId ? ` ${esc(candidate.aiDecisionId)}` : ''} · ${esc(candidate.status)} · ${esc(candidate.usage)} · runtime confirmed: no</span></li>`,
    )
    .join('');
  return `<section><h2>Recording intelligence</h2>
    <p class="muted">PRESERVE FIRST, UNDERSTAND SECOND, OPTIMIZE LAST. The advisor never removes, reorders, invents or changes a human action; what it proposes stays a candidate until the replay confirms it. The generated flow is unchanged.</p>
    <table><tbody>${rows.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join('')}</tbody></table>
    ${candidates ? `<ul class="plain">${candidates}</ul>` : ''}
  </section>`;
}

const ASSESSMENT_COLORS: Record<string, string> = {
  CONFIRMED: '#15803d',
  SUSPICIOUS: '#b45309',
  DISAGREEMENT: '#dc2626',
  INCONCLUSIVE: '#64748b',
  NOT_AUDITED: '#94a3b8',
};

function interpretationText(interpretation: SemanticInterpretation): string {
  const drag = interpretation.drag
    ? ` → "${interpretation.drag.to ?? '?'}"${interpretation.drag.moved ? ' (moved)' : ' (no move observed)'}`
    : '';
  return `${interpretation.interaction} "${interpretation.target}"${interpretation.section ? ` in "${interpretation.section}"` : ''}${drag}`;
}

/**
 * RECORDING AI AUDIT : pour chaque action humaine, le parcours de sa compréhension —
 * action humaine → interprétation déterministe → audit de l'IA → interprétation finale → rejeu.
 */
function recordingAuditHtml(audit: SemanticAuditReport): string {
  const s = audit.summary;
  const rows: [string, string][] = [
    [
      'Audit mode',
      `${audit.mode}${audit.enabled ? '' : ' (disabled)'} · intelligence ${audit.intelligenceMode}`,
    ],
    ['AI calls', String(audit.aiCalls)],
    ['Audited / not audited', `${String(s.audited)} / ${String(s.notAudited)}`],
    ['Confirmed', String(s.confirmed)],
    ['Suspicious', String(s.suspicious)],
    ['Disagreements', String(s.disagreements)],
    ['Inconclusive', String(s.inconclusive)],
    ['To review', String(s.reviewRequired)],
  ];
  const journey = audit.entries
    .map((entry) => {
      const color = ASSESSMENT_COLORS[entry.aiAssessment] ?? '#64748b';
      const ai = entry.aiProposal
        ? `${entry.aiProposal.target ? `"${entry.aiProposal.target}"` : 'no target'}${entry.aiProposal.intent ? ` · ${entry.aiProposal.intent}` : ''} (hypothesis, ${entry.aiProposal.origin}, runtime confirmed: no)`
        : '—';
      return `<tr>
        <td><b>${esc(entry.humanActionId)}</b>${entry.flowStep !== undefined ? ` <span class="muted">step ${String(entry.flowStep)}</span>` : ''}</td>
        <td>${esc(interpretationText(entry.deterministicInterpretation))}<br><span class="muted">confidence ${String(entry.deterministicConfidence)}${entry.auditTrigger.length > 0 ? ` · ${esc(entry.auditTrigger.join(', '))}` : ''}</span></td>
        <td><span style="color:${color};font-weight:600">${esc(entry.aiAssessment)}</span>${entry.aiDecisionId ? ` <span class="muted">${esc(entry.aiDecisionId)}</span>` : ''}<br>${esc(ai)}${entry.citedEvidence.length > 0 ? `<br><span class="muted">evidence ${esc(entry.citedEvidence.join(', '))}</span>` : ''}</td>
        <td>${esc(interpretationText(entry.finalInterpretation))}${entry.reviewRequired ? ' <b style="color:#b45309">review</b>' : ''}<br><span class="muted">${esc(entry.decisionReason)}</span></td>
        <td>${esc(entry.runtimeConfirmation)}</td>
      </tr>`;
    })
    .join('');
  return `<section><h2>Recording AI Audit</h2>
    <p class="muted">The advisor re-reads the deterministic interpretation of each human action; it never captures, removes or rewrites one. A different reading stays a hypothesis (AI_PROPOSAL, runtime confirmed: no) flagged for review; the final interpretation is the deterministic one. Details: semantic-audit.json.</p>
    <table><tbody>${rows.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join('')}</tbody></table>
    ${journey ? `<table><thead><tr><th>Human action</th><th>Deterministic</th><th>AI audit</th><th>Final</th><th>Runtime</th></tr></thead><tbody>${journey}</tbody></table>` : ''}
  </section>`;
}

const VALIDATION_BADGES: Record<string, string> = {
  VALIDATED: '#15803d',
  REPAIRED: '#0369a1',
  FRAGILE: '#b45309',
  AMBIGUOUS: '#b45309',
  UNRESOLVED: '#dc2626',
  NOT_VALIDATED: '#64748b',
  AI_AUDITED: '#7c3aed',
};

const badge = (label: string): string =>
  `<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:${VALIDATION_BADGES[label] ?? '#64748b'};color:#fff;font-size:11px;font-weight:600;margin-right:4px">${esc(label)}</span>`;

/**
 * TARGET VALIDATION : pour chaque action, la cible enregistrée, sa validation immédiate (recherche à
 * sec, jamais rejouée), la réparation, l'audit du conseiller et la cible finale.
 */
function targetValidationHtml(result: RecordingResult): string {
  const report = result.targetValidation;
  const s = report.summary;
  const cards = [
    card('Human actions', String(s.humanActions)),
    card('Validated', String(s.validated)),
    card('After repair', String(s.validatedAfterRepair)),
    card('Fragile', String(s.fragile)),
    card('Ambiguous', String(s.ambiguous)),
    card('Unresolved', String(s.unresolved)),
    card('AI audits', String(s.aiAudits)),
    card('Replay confidence', report.replayConfidence),
  ].join('');
  const rows = report.entries
    .map((entry) => {
      const validation = entry.validation;
      const badges = [
        entry.classification === 'VALIDATED'
          ? 'VALIDATED'
          : entry.classification === 'VALIDATED_FRAGILE'
            ? 'FRAGILE'
            : entry.classification,
        ...(entry.status === 'AMBIGUOUS' ? ['AMBIGUOUS'] : []),
        ...(entry.repairApplied ? ['REPAIRED'] : []),
        ...(entry.aiAudited ? ['AI_AUDITED'] : []),
      ];
      const before = validation
        ? `${esc(validation.validationBefore.status)} <span class="muted">${esc(validation.validationBefore.reason)}</span>${validation.validationBefore.differences
            .map(
              (d) =>
                `<br><span class="muted">${esc(d.property)}: recorded ${esc(d.expected ?? '-')} · runtime ${esc(d.actual ?? '-')}</span>`,
            )
            .join('')}`
        : '<span class="muted">not validated during the recording</span>';
      const repair = validation?.repair
        ? `${esc(validation.repair.type)} ${esc(validation.repair.reason)}<br><span class="muted">${esc(
            validation.repair.changes
              .map((change) => `${change.property}: ${change.before ?? '-'} → ${change.after ?? '-'}`)
              .join(', '),
          )}</span>`
        : '—';
      const ai = validation?.aiAudit
        ? `${esc(validation.aiAudit.outcome)}<br><span class="muted">${esc(validation.aiAudit.reason)}</span>`
        : '—';
      const final = entry.finalTarget ? esc(describeTargetText(entry.finalTarget)) : esc(entry.label);
      return `<tr><td><b>${esc(entry.humanActionId)}</b> ${esc(entry.action)} ${esc(entry.label)}${entry.semanticGroup ? `<br><span class="muted">${esc(entry.semanticGroup)}</span>` : ''}</td>
        <td>${validation?.targetBefore ? esc(describeTargetText(validation.targetBefore)) : '—'}</td>
        <td>${badges.map(badge).join('')}<br>${before}${
          validation?.verdict
            ? `<br><span class="muted">target ${esc(validation.verdict.target.status)} (${esc(validation.verdict.target.source)}) · effect ${esc(validation.verdict.effect.status)} · goal ${esc(validation.verdict.goal.status)}</span>`
            : ''
        }${validation?.preActionCapture ? `<br>${preActionLine(validation)}` : ''}</td><td>${repair}</td><td>${ai}</td>
        <td>${final}${entry.requiresReplayValidation ? '<br><b style="color:#b45309">requires replay validation</b>' : ''}</td></tr>`;
    })
    .join('');
  return `<section><h2>Target validation</h2>
    <p class="muted">RECORD → RESOLVE → VALIDATE → ENRICH → REVALIDATE → PERSIST. Right after each human action, the recorded representation is resolved (dry lookup, never replayed) and compared with the element the human actually used. ${report.coherence.length > 0 ? `Coherence: ${esc(report.coherence.join(' · '))}` : 'The generated journey is coherent.'}</p>
    <div class="cards">${cards}</div>
    ${rows ? `<table><thead><tr><th>Human action</th><th>Recorded target</th><th>Validation</th><th>Repair</th><th>AI audit</th><th>Final target</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
  </section>`;
}

/** La capture pré-action d'une action : capturée ✓, cible originale, candidats, DOM avant → après, statut, IA. */
function preActionLine(validation: RecordingTargetValidation): string {
  const capture = validation.preActionCapture;
  if (!capture) return '';
  const original = validation.verdict.target;
  const dom =
    capture.domGeneration !== undefined
      ? ` · DOM ${String(capture.domGeneration)} → ${String(capture.postGeneration ?? capture.domGeneration)}`
      : '';
  const ai = validation.aiAudit
    ? `AI ${esc(validation.aiAudit.outcome)}${validation.aiAudit.candidate ? ` candidate=${esc(validation.aiAudit.candidate)}` : ''}`
    : 'AI NOT_REQUIRED';
  return capture.complete
    ? `<span class="muted">Pre-action captured ✓ (${esc(capture.phase ?? '-')}) · original ${esc(validation.original.tag ?? '')} / ${esc(validation.original.role ?? '')} · candidates ${String(capture.candidateCount)} · original candidate ${esc(capture.originalCandidateId ?? '-')}${dom} · ${esc(validation.validationStatus ?? original.status)} · ${ai}</span>`
    : `<b style="color:#b45309">${esc(capture.diagnostic ?? 'PRE_ACTION_CAPTURE_INCOMPLETE')}</b>`;
}

function describeTargetText(target: {
  strategy: string;
  role?: string;
  name?: string;
  value?: string;
  section?: string;
  nth?: number;
}): string {
  const base =
    target.strategy === 'role'
      ? `${target.role ?? ''} "${target.name ?? ''}"`
      : `${target.strategy} "${target.value ?? ''}"`;
  return `${base}${target.section ? ` in "${target.section}"` : ''}${target.nth !== undefined ? ` [${String(target.nth)}]` : ''}`;
}

/**
 * Les RECHERCHES reconnues dans les requêtes (http-analysis.json) : critères (libellé → propriété,
 * opérateur, donnée de test), logique, tri, paramètres techniques. Aucune valeur n'y figure.
 */
function searchesHtml(result: RecordingResult): string {
  const searches = (result.http?.consolidated.business ?? []).filter(
    (entry) => entry.operation === 'SEARCH' && entry.searchCriteria.length > 0,
  );
  if (searches.length === 0) return '';
  return `<h3>Search (business interpretation of requests)</h3><ul class="plain">${searches
    .map((entry) => {
      const logic = entry.searchCriteria.find((criterion) => criterion.logicalGroup)?.logicalGroup?.operator;
      const criteria = entry.searchCriteria
        .map(
          (criterion) =>
            `<li>${criterion.ui ? `<b>${esc(criterion.ui.label)}</b> → ` : ''}<code>${esc(criterion.propertyName)}</code> ${esc(criterion.operator ?? '=')} ${criterion.testData ? `<code>${esc(criterion.testData.reference)}</code>` : criterion.ui ? 'typed value' : 'value'} <span class="muted">${esc(criterion.state)} · ${String(Math.round(criterion.confidence * 100))} %${criterion.fromCreation ? ' · from the creation' : ''}</span></li>`,
        )
        .join('');
      const parameters = [
        ...new Set(
          entry.parameters
            .filter((parameter) => parameter.role !== 'SORT')
            .map((parameter) => `${parameter.role.toLowerCase()} ${parameter.path}`),
        ),
      ];
      return `<li><b>${esc(entry.api)}</b> <span class="muted">${esc(entry.state)} · ${String(Math.round(entry.confidence * 100))} %${entry.technical ? ` · technical classification ${esc(entry.technical.category)} (separate)` : ''}</span><ul>${criteria}</ul>${logic ? `<p class="muted">Logic: ${esc(logic)}</p>` : ''}${entry.sort.length ? `<p class="muted">Sort: ${esc(entry.sort.map((sort) => `${sort.property ?? sort.path} ${sort.direction.toUpperCase()}`).join(', '))}</p>` : ''}${parameters.length ? `<p class="muted">Technical parameters: ${esc(parameters.join(' · '))}</p>` : ''}</li>`;
    })
    .join('')}</ul>`;
}
