import type { ExplorationResult } from '../model/exploration-result.js';
import type { PersistenceReport } from '../model/persistence-report.js';
import { esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/** Section « Persistance et mémoire » du rapport HTML (anglais / français). Jamais d'identifiants. */
const TEXTS = {
  en: {
    title: 'Persistence and memory',
    persistence: 'Persistence',
    memory: 'Memory',
    enabled: 'Enabled',
    yes: 'yes',
    no: 'no',
    configured: 'Configured',
    actual: 'Actual',
    reason: 'Reason',
    status: 'Status',
    location: 'Location',
    latency: 'Latency',
    schema: 'Schema version',
    runId: 'Run id',
    writeErrors: 'Write errors (the crawl went on)',
    mode: 'Mode',
    historical: 'Historical knowledge',
    statesLoaded: 'Historical states loaded',
    transitionsLoaded: 'Historical transitions loaded',
    newStates: 'New states learned',
    newTransitions: 'New transitions learned',
    modes: {
      legacy: 'knowledge base file (knowledge.*), as before',
      isolated: 'isolated run: nothing from previous runs',
      'current-run': 'current run only (no history loaded)',
      historical: 'history preloaded from the persistence into the working memory',
    },
    hint: 'Persistence says WHERE this run is stored; memory says whether previous runs influenced it. History is an expectation, never a business truth.',
  },
  fr: {
    title: 'Persistance et mémoire',
    persistence: 'Persistance',
    memory: 'Mémoire',
    enabled: 'Activée',
    yes: 'oui',
    no: 'non',
    configured: 'Configurée',
    actual: 'Réellement utilisée',
    reason: 'Raison',
    status: 'État',
    location: 'Emplacement',
    latency: 'Latence',
    schema: 'Version du schéma',
    runId: 'Id du run',
    writeErrors: "Erreurs d'écriture (le crawl a continué)",
    mode: 'Mode',
    historical: 'Connaissance historique',
    statesLoaded: 'États historiques chargés',
    transitionsLoaded: 'Transitions historiques chargées',
    newStates: 'Nouveaux états appris',
    newTransitions: 'Nouvelles transitions apprises',
    modes: {
      legacy: 'base de connaissances fichier (knowledge.*), comme avant',
      isolated: 'run isolé : rien des runs précédents',
      'current-run': 'run courant seulement (aucun historique chargé)',
      historical: 'historique préchargé depuis la persistance dans la mémoire de travail',
    },
    hint: "La persistance dit OÙ ce run est enregistré ; la mémoire dit si les runs précédents l'ont influencé. L'historique est une attente, jamais une vérité métier.",
  },
} as const;

/** « database (PostgreSQL) », « file ». */
export function storageLabel(storage: { provider: string; database?: string } | undefined): string {
  if (!storage) return '-';
  return storage.database ? `${storage.provider} (${storage.database})` : storage.provider;
}

export function persistenceSection(result: ExplorationResult, language: ReportLanguage): string {
  const report: PersistenceReport | undefined = result.persistence;
  if (!report) return '';
  const t = TEXTS[language];
  const row = (label: string, value: string | number | undefined): string =>
    value === undefined || value === ''
      ? ''
      : `<tr><th>${esc(label)}</th><td>${esc(String(value))}</td></tr>`;
  const persistence = [
    row(t.enabled, report.enabled ? t.yes : t.no),
    report.enabled ? row(t.configured, storageLabel(report.configured)) : '',
    report.enabled ? row(t.actual, storageLabel(report.actual)) : '',
    row(t.status, report.status),
    row(t.reason, report.reason),
    row(t.location, report.actual?.location),
    row(t.latency, report.latencyMs !== undefined ? `${report.latencyMs} ms` : undefined),
    row(t.schema, report.schemaVersion),
    row(t.runId, report.runId),
    report.writeErrors.length > 0 ? row(t.writeErrors, report.writeErrors.join(' · ')) : '',
  ].join('');
  const { memory } = report;
  const memoryRows = [
    row(t.enabled, memory.enabled ? t.yes : t.no),
    row(t.mode, t.modes[memory.mode]),
    row(t.historical, memory.historicalKnowledge ? t.yes : t.no),
    row(t.statesLoaded, memory.historicalStatesLoaded),
    row(t.transitionsLoaded, memory.historicalTransitionsLoaded),
    row(t.newStates, memory.newStatesLearned),
    row(t.newTransitions, memory.newTransitionsLearned),
  ].join('');
  return `<section><h2>${esc(t.title)}</h2><p class="muted">${esc(t.hint)}</p>
  <h3>${esc(t.persistence)}</h3><table>${persistence}</table>
  <h3>${esc(t.memory)}</h3><table>${memoryRows}</table></section>`;
}
