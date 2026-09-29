import type { ExplorationResult } from '../model/exploration-result.js';
import { esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/** Section « Régression » du rapport HTML : évolution des flows, cycle de vie des anomalies, stabilité. */
const TEXTS = {
  en: {
    title: 'Regression across versions',
    hint: 'What changed since the previous runs, and where each anomaly stands. An element is declared gone only when its screen was seen again without it (or after a complete exploration); an anomaly is RESOLVED only after consecutive verified checks.',
    skipped: 'Not computed',
    evolution: 'Flow evolution',
    tracked: 'Tracked',
    states: 'states',
    transitions: 'transitions',
    flows: 'flows',
    disappeared: 'gone',
    noChange: 'No change since the previous runs.',
    element: 'Element',
    change: 'Change',
    detail: 'Detail',
    since: 'First seen',
    versions: 'Versions',
    imposedFlows: 'Imposed flows across versions',
    flow: 'Flow',
    runs: 'Runs',
    pathChanges: 'Path changes',
    anomalies: 'Anomaly lifecycle',
    anomaly: 'Anomaly',
    status: 'Status',
    occurrences: 'Occurrences (runs)',
    firstSeen: 'First seen',
    reproduction: 'Reproduction path',
    checks: 'Clean checks',
    stability: 'Stability of known transitions',
  },
  fr: {
    title: 'Régression d’une version à l’autre',
    hint: 'Ce qui a changé depuis les runs précédents, et où en est chaque anomalie. Un élément n’est déclaré disparu que si son écran a été revu sans lui (ou après une exploration complète) ; une anomalie n’est RÉSOLUE qu’après des vérifications consécutives.',
    skipped: 'Non calculé',
    evolution: 'Évolution des flows',
    tracked: 'Suivis',
    states: 'états',
    transitions: 'transitions',
    flows: 'flows',
    disappeared: 'disparus',
    noChange: 'Aucun changement depuis les runs précédents.',
    element: 'Élément',
    change: 'Changement',
    detail: 'Détail',
    since: 'Vu la première fois',
    versions: 'Versions',
    imposedFlows: 'Flows imposés d’une version à l’autre',
    flow: 'Flow',
    runs: 'Runs',
    pathChanges: 'Changements de chemin',
    anomalies: 'Cycle de vie des anomalies',
    anomaly: 'Anomalie',
    status: 'Statut',
    occurrences: 'Occurrences (runs)',
    firstSeen: 'Vue la première fois',
    reproduction: 'Chemin de reproduction',
    checks: 'Vérifications sans elle',
    stability: 'Stabilité des transitions connues',
  },
} as const;

const date = (iso: string): string => iso.slice(0, 10);

export function regressionSection(result: ExplorationResult, language: ReportLanguage): string {
  const t = TEXTS[language];
  const parts: string[] = [];
  const regression = result.regression;
  const flakiness = result.intelligence?.historicalKnowledge?.flakiness;
  if (!regression && !flakiness) return '';
  parts.push(`<p class="muted">${esc(t.hint)}</p>`);
  if (regression?.skipped)
    parts.push(`<p><strong>${esc(t.skipped)}</strong> : ${esc(regression.skipped)}</p>`);

  const evolution = regression?.evolution;
  if (evolution) {
    parts.push(
      `<h3>${esc(t.evolution)}</h3><p><strong>${esc(t.tracked)}</strong> : ${evolution.tracked.STATE} ${esc(t.states)} · ${evolution.tracked.TRANSITION} ${esc(t.transitions)} · ${evolution.tracked.FLOW} ${esc(t.flows)} · ${evolution.disappeared} ${esc(t.disappeared)}</p>`,
    );
    if (evolution.changes.length === 0) parts.push(`<p class="muted">${esc(t.noChange)}</p>`);
    else
      parts.push(
        `<table><tr><th>${esc(t.element)}</th><th>${esc(t.change)}</th><th>${esc(t.detail)}</th><th>${esc(t.since)}</th><th>${esc(t.versions)}</th></tr>${evolution.changes
          .slice(0, 60)
          .map(
            (change) =>
              `<tr><td>${esc(change.kind)} ${esc(change.label)}</td><td>${esc(change.change)}</td><td class="wrap">${esc(change.detail ?? '')}</td><td>${esc(date(change.firstSeen.at))} (${esc(change.firstSeen.version)})</td><td>${change.versionCount}</td></tr>`,
          )
          .join('')}</table>`,
      );
    if (evolution.flows.length > 0)
      parts.push(
        `<h3>${esc(t.imposedFlows)}</h3><table><tr><th>${esc(t.flow)}</th><th>${esc(t.versions)}</th><th>${esc(t.runs)}</th><th>${esc(t.pathChanges)}</th><th>${esc(t.since)}</th></tr>${evolution.flows
          .map(
            (flow) =>
              `<tr><td>${esc(flow.name)}</td><td>${flow.versionCount}</td><td>${flow.runs}</td><td>${flow.pathChanges}</td><td>${esc(date(flow.firstSeen))}</td></tr>`,
          )
          .join('')}</table>`,
      );
  }

  const anomalies = regression?.anomalies;
  if (anomalies) {
    parts.push(
      `<h3>${esc(t.anomalies)}</h3><p>${Object.entries(anomalies.counts)
        .map(([status, count]) => `<strong>${esc(status)}</strong> ${count}`)
        .join(' · ')}</p>`,
    );
    if (anomalies.entries.length > 0)
      parts.push(
        `<table><tr><th>${esc(t.anomaly)}</th><th>${esc(t.status)}</th><th>${esc(t.occurrences)}</th><th>${esc(t.firstSeen)}</th><th>${esc(t.reproduction)}</th><th>${esc(t.checks)}</th></tr>${anomalies.entries
          .slice(0, 60)
          .map(
            (entry) =>
              `<tr><td>${esc(entry.id)} ${esc(entry.type)}<br><span class="muted">${esc(entry.message.slice(0, 160))}</span></td><td>${esc(entry.status)}</td><td>${entry.occurrenceCount} (${entry.runsSeen})</td><td>${esc(date(entry.firstSeen.at))} (${esc(entry.firstSeen.version)})</td><td class="wrap">${esc(entry.reproductionPath.join(' → '))}</td><td>${entry.cleanChecks}</td></tr>`,
          )
          .join('')}</table>`,
      );
  }

  if (flakiness) {
    const total = Object.values(flakiness).reduce((sum, count) => sum + count, 0);
    parts.push(
      `<h3>${esc(t.stability)}</h3><p>${Object.entries(flakiness)
        .map(
          ([kind, count]) =>
            `<strong>${esc(kind)}</strong> ${count}${total > 0 ? ` (${Math.round((count / total) * 100)} %)` : ''}`,
        )
        .join(' · ')}</p>`,
    );
  }
  return `<section><h2>${esc(t.title)}</h2>${parts.join('\n')}</section>`;
}
