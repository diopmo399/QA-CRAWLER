import type { ExplorationResult } from '../model/exploration-result.js';
import { esc } from './html-common.js';
import type { ReportLanguage } from './i18n.js';

/** Section « Analyse statique » du rapport HTML : ce que le code a apporté, et ce que l'exécution a confirmé. */
const TEXTS = {
  en: {
    title: 'Static analysis (application code)',
    hint: 'The code is evidence, never a runtime truth: a field or a route is STATIC_DISCOVERED until the browser confirms it.',
    status: 'Status',
    statuses: {
      USED: 'used',
      NOT_NEEDED: 'not needed (on demand: no field needed it)',
      UNAVAILABLE: 'unavailable (the run went on without it)',
    },
    mode: 'Mode',
    framework: 'Framework',
    coverage: 'Coverage',
    cache: 'Cache',
    files: 'Files read',
    duration: 'Duration',
    found: 'Found',
    dataFlows: 'Data flows (resolved / unresolved)',
    confirmedFields: 'Fields confirmed at runtime',
    confirmedRoutes: 'Routes confirmed at runtime',
    warnings: 'Limits',
    counts: (routes: number, forms: number, fields: number, api: number): string =>
      `${String(routes)} route(s), ${String(forms)} form(s), ${String(fields)} field(s), ${String(api)} API call(s)`,
    discovery: 'Static source discovery',
    discoveryHint:
      'Where the analyzed code came from. Only paths and hashes are shown, never the source code itself.',
    strategy: 'Strategy',
    origins: 'Origins',
    bundles: 'Bundles read (of which lazy)',
    maps: 'Source maps (referenced / loaded / partial / rejected)',
    extracted: 'Sources extracted from source maps',
    bundleOnly: 'Bundles analyzed without source map',
    conflicts: 'Conflicting sources (first kept)',
    mismatches: 'Repository ≠ deployed build (deployed build used)',
    bundleSetHash: 'Bundle set hash',
    columns: ['Bundle', 'Source map', 'Status', 'Sources'],
    lazy: 'lazy',
  },
  fr: {
    title: 'Analyse statique (code de l’application)',
    hint: 'Le code est une preuve, jamais une vérité d’exécution : un champ ou une route reste STATIC_DISCOVERED tant que le navigateur ne l’a pas confirmé.',
    status: 'État',
    statuses: {
      USED: 'utilisée',
      NOT_NEEDED: 'pas nécessaire (à la demande : aucun champ n’en a eu besoin)',
      UNAVAILABLE: 'indisponible (le run a continué sans elle)',
    },
    mode: 'Mode',
    framework: 'Framework',
    coverage: 'Couverture',
    cache: 'Cache',
    files: 'Fichiers lus',
    duration: 'Durée',
    found: 'Trouvé',
    dataFlows: 'Flux de données (résolus / non résolus)',
    confirmedFields: 'Champs confirmés à l’exécution',
    confirmedRoutes: 'Routes confirmées à l’exécution',
    warnings: 'Limites',
    counts: (routes: number, forms: number, fields: number, api: number): string =>
      `${String(routes)} route(s), ${String(forms)} formulaire(s), ${String(fields)} champ(s), ${String(api)} appel(s) d’API`,
    discovery: 'Découverte des sources',
    discoveryHint:
      'D’où vient le code analysé. Seuls chemins et empreintes sont affichés, jamais le code source lui-même.',
    strategy: 'Stratégie',
    origins: 'Origines',
    bundles: 'Bundles lus (dont à la demande)',
    maps: 'Source maps (référencées / chargées / partielles / rejetées)',
    extracted: 'Sources extraites des source maps',
    bundleOnly: 'Bundles analysés sans source map',
    conflicts: 'Sources en conflit (la première gardée)',
    mismatches: 'Dépôt ≠ build déployé (le build déployé est utilisé)',
    bundleSetHash: 'Empreinte des bundles',
    columns: ['Bundle', 'Source map', 'État', 'Sources'],
    lazy: 'à la demande',
  },
} as const;

export function staticAnalysisSection(result: ExplorationResult, language: ReportLanguage): string {
  const summary = result.staticAnalysis;
  if (!summary) return '';
  const t = TEXTS[language];
  const row = (label: string, value: string | number | undefined): string =>
    value === undefined || value === ''
      ? ''
      : `<tr><th>${esc(label)}</th><td>${esc(String(value))}</td></tr>`;
  const rows = [
    row(t.status, t.statuses[summary.status]),
    row(t.mode, summary.mode),
    row(t.framework, summary.framework),
    row(t.coverage, summary.coverage),
    row(t.cache, summary.cache),
    row(t.files, summary.files),
    row(t.duration, summary.durationMs !== undefined ? `${String(summary.durationMs)} ms` : undefined),
    summary.routes !== undefined
      ? row(t.found, t.counts(summary.routes, summary.forms ?? 0, summary.fields ?? 0, summary.apiCalls ?? 0))
      : '',
    summary.dataFlows
      ? row(t.dataFlows, `${String(summary.dataFlows.resolved)} / ${String(summary.dataFlows.unresolved)}`)
      : '',
    summary.confirmedFields.length > 0 ? row(t.confirmedFields, summary.confirmedFields.join(', ')) : '',
    summary.confirmedRoutes.length > 0 ? row(t.confirmedRoutes, summary.confirmedRoutes.join(', ')) : '',
    summary.warnings.length > 0 ? row(t.warnings, summary.warnings.join(' · ')) : '',
  ].join('');
  return `<section><h2>${esc(t.title)}</h2><p class="muted">${esc(t.hint)}</p><table>${rows}</table>${discoverySection(summary.discovery, language)}</section>`;
}

/** « Static Source Discovery » : bundles, source maps, ce qui en a été tiré — jamais le code. */
function discoverySection(
  discovery: NonNullable<ExplorationResult['staticAnalysis']>['discovery'],
  language: ReportLanguage,
): string {
  if (!discovery) return '';
  const t = TEXTS[language];
  const row = (label: string, value: string | number | undefined): string =>
    value === undefined || value === ''
      ? ''
      : `<tr><th>${esc(label)}</th><td>${esc(String(value))}</td></tr>`;
  const maps = discovery.sourceMaps;
  const rows = [
    row(t.strategy, discovery.strategy),
    row(t.origins, discovery.origins.join(' + ')),
    row(t.bundles, `${String(discovery.bundles)} (${String(discovery.lazyBundles)})`),
    row(
      t.maps,
      `${String(maps.referenced)} / ${String(maps.loaded)} / ${String(maps.partial)} / ${String(maps.rejected)}`,
    ),
    row(t.extracted, discovery.extractedSources),
    discovery.bundleOnly > 0 ? row(t.bundleOnly, discovery.bundleOnly) : '',
    discovery.conflicts.length > 0 ? row(t.conflicts, discovery.conflicts.join(', ')) : '',
    discovery.mismatches.length > 0 ? row(t.mismatches, discovery.mismatches.join(', ')) : '',
    row(t.bundleSetHash, discovery.bundleSetHash?.slice(0, 16)),
  ].join('');
  const entries = discovery.entries
    .map(
      (entry) =>
        `<tr><td>${esc(entry.url)}${entry.lazy ? ` <span class="muted">(${esc(t.lazy)})</span>` : ''}</td><td>${esc(entry.sourceMap ?? '—')}</td><td>${esc(entry.status)}${entry.reason ? ` <span class="muted">${esc(entry.reason)}</span>` : ''}</td><td>${esc(String(entry.extracted))}</td></tr>`,
    )
    .join('');
  const table =
    entries === ''
      ? ''
      : `<table><thead><tr>${t.columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${entries}</tbody></table>`;
  return `<h3>${esc(t.discovery)}</h3><p class="muted">${esc(t.discoveryHint)}</p><table>${rows}</table>${table}`;
}
