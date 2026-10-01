import { BASE_CSS, card, esc } from '../reporting/html-common.js';
import { describeStep } from '../config/flow-schema.js';
import type { RawRecordedEvent, SemanticRecordedAction } from './model.js';
import type { RecordingResult } from './process-recording.js';

export type ReplayStatus = 'REPLAY_CONFIRMED' | 'REPLAY_FAILED' | 'NOT_VALIDATED';

export interface ReplayOutcome {
  status: ReplayStatus;
  /** Statut du dry run qui a rejoué le flow (FULLY_MATCHED…). */
  dryRunStatus?: string;
  reason?: string;
  report?: string;
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
  <section><h2>Understood intent</h2>
    <p>${intent.workflow ? `<b>${esc(intent.workflow)}</b>${intent.api ? ` · ${esc(intent.api)}` : ''}` : 'No business write observed.'}${flow.negative ? ' · <b>negative validation flow</b>' : ''}</p>
    ${intent.transitions.length > 0 ? `<ul class="plain">${intent.transitions.map((transition) => `<li>${esc(transition.entity)}: ${esc(transition.from)} → ${esc(transition.to)}</li>`).join('')}</ul>` : ''}
    ${intent.evidence.length > 0 ? `<p class="muted">${esc(intent.evidence.join(' · '))}</p>` : ''}
  </section>
  <section><h2>Quality</h2>
    <div class="cols"><div><h3>Locators</h3><ul class="plain">${locators || '<li class="muted">none</li>'}</ul></div>
    <div><h3>Values</h3><ul class="plain">${values || '<li class="muted">none</li>'}</ul></div></div>
    <p class="muted">Facts to judge, not a grade: a FRAGILE locator or an ambiguous target is worth a look before the flow goes into the suite.</p>
  </section>
  ${warnings ? `<section><h2>Warnings</h2><ul class="plain">${warnings}</ul></section>` : ''}
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
