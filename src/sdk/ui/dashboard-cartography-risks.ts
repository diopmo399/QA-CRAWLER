import type { Evidence, MapPage } from '../core/cartography.js';
import {
  RISK_CATEGORIES,
  RISK_SEVERITIES,
  RISK_STATUSES,
  type Risk,
  type RiskImpact,
  type RiskImpactNode,
  type RiskPage,
  type RiskSummary,
} from '../core/risk.js';
import { arrowMarkers, arrowSvg, orthPath, type ArrowRole } from './dashboard-cartography-arrows.js';
import { icon } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * L'ÉCRAN « RISQUES D'ANOMALIES » (Qualité) : les comptes, la répartition, l'évolution face au scan précédent,
 * une liste filtrable et, au clic, le détail d'un risque — cause, conditions, code, preuves, données, impact,
 * vérifications, correction proposée. Une hypothèse n'est jamais présentée comme une anomalie : chaque ligne
 * dit son statut (potentiel, corroboré, reproduit, réfuté, inconclusif) et sa confiance, distincte de la
 * sévérité.
 */
export interface RisksUi {
  risks?: RiskPage;
  risk?: Risk;
  riskImpact?: RiskImpact;
  rDepth: number;
  rPage: number;
  rCategory: string;
  rSeverity: string;
  rStatus: string;
  rLayer: string;
  rFeature: string;
  rConf: string;
  rQuery: string;
  rSuppressed: boolean;
  /** Le formulaire ouvert dans le détail : déclarer un test, supprimer. */
  rForm?: 'test' | 'suppress';
  rNotice?: string;
  rRules?: boolean;
}

export const emptyRisks = (): RisksUi => ({
  rDepth: 5,
  rPage: 1,
  rCategory: '',
  rSeverity: '',
  rStatus: '',
  rLayer: '',
  rFeature: '',
  rConf: '',
  rQuery: '',
  rSuppressed: false,
});

const TEXT = {
  fr: {
    title: 'Risques d’anomalies',
    intro:
      'Risques détectés avant toute erreur observée, à partir du code lu et du graphe de la cartographie. Chaque risque est une hypothèse étayée : son statut dit jusqu’où il a été vérifié, sa confiance la force des preuves.',
    kpis: {
      total: 'Risques',
      critical: 'Sévérité haute',
      corroborated: 'Corroborés',
      reproduced: 'Reproduits',
      features: 'Fonctionnalités impactées',
      suppressed: 'Supprimés',
    },
    byCategory: 'Par catégorie',
    byLayer: 'Par couche',
    diff: (a: number, r: number, u: number) =>
      `Depuis le scan précédent : ${String(a)} nouveau(x), ${String(r)} disparu(s), ${String(u)} inchangé(s)`,
    noPrevious: 'Pas de scan précédent comparable.',
    categories: {
      STATE: 'État partagé',
      ASYNC: 'Asynchrone',
      CLEANUP: 'Ressources',
      ERROR: 'Erreurs',
      BACKEND: 'BFF / Backend',
    } as Record<string, string>,
    severities: { CRITICAL: 'Critique', HIGH: 'Haute', MEDIUM: 'Moyenne', LOW: 'Basse' } as Record<
      string,
      string
    >,
    statuses: {
      POTENTIAL: 'Potentiel',
      CORROBORATED: 'Corroboré',
      REPRODUCED: 'Reproduit',
      REFUTED: 'Réfuté',
      INCONCLUSIVE: 'Inconclusif',
    } as Record<string, string>,
    layers: {
      FRONTEND: 'Frontend',
      BFF: 'BFF',
      BACKEND: 'Backend',
      API: 'API',
      DATABASE: 'Base',
      EVENTS: 'Événements',
      OTHER: 'Autre',
    } as Record<string, string>,
    all: 'Toutes',
    allF: 'Tous',
    search: 'Rechercher (titre, entité, règle, fichier)',
    feature: 'Fonctionnalité',
    layer: 'Couche',
    confidence: 'Confiance min.',
    showSuppressed: 'Afficher les supprimés',
    cols: [
      'Risque',
      'Catégorie',
      'Sévérité',
      'Confiance',
      'Statut',
      'Source',
      'Fonctionnalités impactées',
      'Dernière détection',
    ],
    none: 'Aucun risque détecté dans ce scan.',
    noneFiltered: 'Aucun risque pour ces critères.',
    noFacts: (s: string) =>
      `Sources sans faits de risque (scan antérieur au moteur) : ${s}. Relancer un scan pour les analyser.`,
    change: { NEW: 'nouveau', UNCHANGED: 'inchangé', CHANGED: 'modifié' } as Record<string, string>,
    close: 'Fermer',
    sections: {
      description: 'Description',
      cause: 'Cause technique suspectée',
      conditions: 'Conditions nécessaires',
      code: 'Code concerné',
      evidence: 'Preuves',
      data: 'Données affectées',
      features: 'Fonctionnalités impactées',
      propagation: 'Parcours de propagation',
      verifications: 'Vérifications réalisées',
      results: 'Résultats',
      suggestion: 'Correction suggérée',
      impact: 'Graphe d’impact',
      limits: 'Hypothèses, inconnues et limites',
      confidence: 'Calcul de la confiance',
      plan: 'Test ciblé proposé (à exécuter dans le projet)',
    },
    relation: { SUPPORTS: 'soutient', WEAKENS: 'affaiblit', CONTEXT: 'contexte' } as Record<string, string>,
    reliability: { HIGH: 'fiable', MEDIUM: 'moyenne', LOW: 'faible' } as Record<string, string>,
    assumptions: 'Hypothèses',
    unknowns: 'Inconnues',
    limits: 'Limites de la règle',
    noVerification: 'Aucune vérification encore.',
    simulate: 'Vérifier (simulation)',
    declare: 'Déclarer un test exécuté',
    suppress: 'Supprimer (faux positif)',
    unsuppress: 'Lever la suppression',
    suppressed: (by: string, reason: string) => `Supprimé par ${by} : ${reason}`,
    reason: 'Raison (obligatoire)',
    outcome: 'Résultat',
    observed: 'Observé',
    expected: 'Attendu métier (facultatif)',
    save: 'Enregistrer',
    cancel: 'Annuler',
    expand: 'Développer l’impact',
    truncated: 'Exploration bornée : développer pour voir plus loin.',
    blocked: 'Frontières (propagation arrêtée)',
    legend: {
      PROVEN: 'lien prouvé',
      INFERRED: 'déduit',
      UNCERTAIN: 'incertain',
      TESTED: 'chemin testé',
      REFUTED: 'chemin réfuté',
    } as Record<string, string>,
    roles: {
      SOURCE: 'Source',
      DATA: 'Donnée',
      STATE: 'État / traitement',
      CONSUMER: 'Consommateurs',
      DOWNSTREAM: 'Aval',
      FEATURE: 'Fonctionnalités',
    } as Record<string, string>,
    noImpact: 'Aucun parcours d’impact dans le graphe pour ce risque.',
    stale: 'périmée (le code a changé)',
    method: {
      STATE_SIMULATION: 'Simulation des transitions',
      EXTERNAL_TEST: 'Test du projet (déclaré)',
    } as Record<string, string>,
    rules: 'Règles',
    rulesIntro:
      'Activer ou désactiver une règle. Une règle désactivée n’est plus exécutée au prochain calcul.',
    metrics: (ms: number, files: number, rules: number, paths: number) =>
      `Calcul : ${String(ms)} ms · ${String(files)} fichier(s) · ${String(rules)} règle(s) · ${String(paths)} nœud(s) parcourus`,
    direct: 'direct',
  },
  en: {
    title: 'Anomaly risks',
    intro:
      'Risks detected before any observed error, from the code read and the cartography graph. Each risk is a supported hypothesis: its status says how far it was checked, its confidence how strong the evidence is.',
    kpis: {
      total: 'Risks',
      critical: 'High severity',
      corroborated: 'Corroborated',
      reproduced: 'Reproduced',
      features: 'Impacted features',
      suppressed: 'Suppressed',
    },
    byCategory: 'By category',
    byLayer: 'By layer',
    diff: (a: number, r: number, u: number) =>
      `Since the previous scan: ${String(a)} new, ${String(r)} gone, ${String(u)} unchanged`,
    noPrevious: 'No comparable previous scan.',
    categories: {
      STATE: 'Shared state',
      ASYNC: 'Asynchronous',
      CLEANUP: 'Resources',
      ERROR: 'Errors',
      BACKEND: 'BFF / Backend',
    } as Record<string, string>,
    severities: { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' } as Record<
      string,
      string
    >,
    statuses: {
      POTENTIAL: 'Potential',
      CORROBORATED: 'Corroborated',
      REPRODUCED: 'Reproduced',
      REFUTED: 'Refuted',
      INCONCLUSIVE: 'Inconclusive',
    } as Record<string, string>,
    layers: {
      FRONTEND: 'Frontend',
      BFF: 'BFF',
      BACKEND: 'Backend',
      API: 'API',
      DATABASE: 'Database',
      EVENTS: 'Events',
      OTHER: 'Other',
    } as Record<string, string>,
    all: 'All',
    allF: 'All',
    search: 'Search (title, entity, rule, file)',
    feature: 'Feature',
    layer: 'Layer',
    confidence: 'Min. confidence',
    showSuppressed: 'Show suppressed',
    cols: [
      'Risk',
      'Category',
      'Severity',
      'Confidence',
      'Status',
      'Source',
      'Impacted features',
      'Last detection',
    ],
    none: 'No risk detected in this scan.',
    noneFiltered: 'No risk for these criteria.',
    noFacts: (s: string) =>
      `Sources without risk facts (scan older than the engine): ${s}. Run a scan to analyse them.`,
    change: { NEW: 'new', UNCHANGED: 'unchanged', CHANGED: 'changed' } as Record<string, string>,
    close: 'Close',
    sections: {
      description: 'Description',
      cause: 'Suspected technical cause',
      conditions: 'Required conditions',
      code: 'Code',
      evidence: 'Evidence',
      data: 'Affected data',
      features: 'Impacted features',
      propagation: 'Propagation path',
      verifications: 'Verifications',
      results: 'Results',
      suggestion: 'Suggested fix',
      impact: 'Impact graph',
      limits: 'Assumptions, unknowns and limits',
      confidence: 'Confidence breakdown',
      plan: 'Proposed targeted test (to run in the project)',
    },
    relation: { SUPPORTS: 'supports', WEAKENS: 'weakens', CONTEXT: 'context' } as Record<string, string>,
    reliability: { HIGH: 'reliable', MEDIUM: 'medium', LOW: 'weak' } as Record<string, string>,
    assumptions: 'Assumptions',
    unknowns: 'Unknowns',
    limits: 'Rule limits',
    noVerification: 'No verification yet.',
    simulate: 'Verify (simulation)',
    declare: 'Declare a test run',
    suppress: 'Suppress (false positive)',
    unsuppress: 'Lift the suppression',
    suppressed: (by: string, reason: string) => `Suppressed by ${by}: ${reason}`,
    reason: 'Reason (required)',
    outcome: 'Outcome',
    observed: 'Observed',
    expected: 'Business expectation (optional)',
    save: 'Save',
    cancel: 'Cancel',
    expand: 'Expand the impact',
    truncated: 'Bounded exploration: expand to see further.',
    blocked: 'Boundaries (propagation stopped)',
    legend: {
      PROVEN: 'proven link',
      INFERRED: 'inferred',
      UNCERTAIN: 'uncertain',
      TESTED: 'tested path',
      REFUTED: 'refuted path',
    } as Record<string, string>,
    roles: {
      SOURCE: 'Source',
      DATA: 'Data',
      STATE: 'State / processing',
      CONSUMER: 'Consumers',
      DOWNSTREAM: 'Downstream',
      FEATURE: 'Features',
    } as Record<string, string>,
    noImpact: 'No impact path in the graph for this risk.',
    stale: 'stale (the code changed)',
    method: { STATE_SIMULATION: 'Transition simulation', EXTERNAL_TEST: 'Project test (declared)' } as Record<
      string,
      string
    >,
    rules: 'Rules',
    rulesIntro: 'Enable or disable a rule. A disabled rule is no longer run at the next computation.',
    metrics: (ms: number, files: number, rules: number, paths: number) =>
      `Computation: ${String(ms)} ms · ${String(files)} file(s) · ${String(rules)} rule(s) · ${String(paths)} node(s) explored`,
    direct: 'direct',
  },
};

type T = (typeof TEXT)['fr'];

const NOTICES = {
  fr: {
    riskVerified: 'Vérification enregistrée.',
    riskUnsuppressed: 'Suppression levée.',
    riskSuppressed: 'Risque supprimé (la raison est gardée).',
    riskRecorded: 'Résultat du test enregistré.',
  },
  en: {
    riskVerified: 'Verification recorded.',
    riskUnsuppressed: 'Suppression lifted.',
    riskSuppressed: 'Risk suppressed (the reason is kept).',
    riskRecorded: 'Test result recorded.',
  },
};

/** Le message affiché après une action sur un risque. */
export const riskNotice = (locale: string, key: keyof (typeof NOTICES)['fr']): string =>
  NOTICES[locale === 'en' ? 'en' : 'fr'][key];

export interface RiskHelpers {
  locale: 'fr' | 'en';
  evidence: (e: Evidence) => string;
  pager: (list: string, page: MapPage<unknown>, sizes: readonly number[]) => string;
  spinner: () => string;
  paneError: (error: string) => string;
  loading: boolean;
  detailLoading: boolean;
  error?: string;
  detailError?: string;
  canRun: boolean;
  canDecide: boolean;
  features: { id: string; name: string }[];
}

/** Le scan d'une détection, lu comme une date (« scan-2026-11-23T06-25-17… » → « 2026-11-23 06:25 »). */
const seen = (scanId: string): string => {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/.exec(scanId);
  return m ? `${m[1] ?? ''} ${m[2] ?? ''}:${m[3] ?? ''}` : scanId;
};
/** Les colonnes masquées quand le détail est ouvert (la liste garde l'essentiel). */
const COL_CLASS = ['', 'c-opt', '', '', '', 'c-opt', '', 'c-opt'];
const pct = (n: number): string => `${String(Math.round(n * 100))} %`;
const sevTone = (s: string): string =>
  s === 'CRITICAL' || s === 'HIGH' ? 'hi' : s === 'MEDIUM' ? 'md' : 'lo';
const statusTone = (s: string): string =>
  s === 'REPRODUCED'
    ? 'rep'
    : s === 'CORROBORATED'
      ? 'cor'
      : s === 'REFUTED'
        ? 'ref'
        : s === 'INCONCLUSIVE'
          ? 'inc'
          : 'pot';

function select(
  name: string,
  label: string,
  value: string,
  options: [string, string][],
  allText: string,
): string {
  return `<label class="pick">${esc(label)} <select data-map="${name}"><option value="">${esc(allText)}</option>${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}

function bars(
  t: T,
  title: string,
  counts: Partial<Record<string, number>>,
  labels: Record<string, string>,
): string {
  const entries = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0) as [string, number][];
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return `<div class="rk-dist"><h4>${esc(title)}</h4>${entries.length ? entries.map(([k, n]) => `<div class="rk-bar"><span>${esc(labels[k] ?? k)}</span><i style="--w:${String(Math.round((n / max) * 100))}%"></i><b>${String(n)}</b></div>`).join('') : `<p class="mu small">—</p>`}</div>`;
}

function header(t: T, s: RiskSummary): string {
  const tile = (key: keyof T['kpis'], n: number, tone = ''): string =>
    `<div class="rk-kpi ${tone}" data-kpi="${key}"><b>${String(n)}</b><span>${esc(t.kpis[key])}</span></div>`;
  const diff = s.diff ? t.diff(s.diff.added, s.diff.resolved, s.diff.unchanged) : t.noPrevious;
  return `<div class="rk-kpis">${tile('total', s.total)}${tile('critical', s.critical, 'hi')}${tile('corroborated', s.corroborated, 'cor')}${tile('reproduced', s.reproduced, 'rep')}${tile('features', s.features)}${tile('suppressed', s.suppressed, 'mu')}</div><div class="rk-dists">${bars(t, t.byCategory, s.byCategory, t.categories)}${bars(t, t.byLayer, s.byLayer, t.layers)}</div><p class="mu small rk-diff">${esc(diff)} · ${esc(t.metrics(s.metrics.durationMs, s.metrics.filesExamined, s.metrics.rulesRun, s.metrics.pathsExplored))}</p>${s.metrics.sourcesWithoutFacts.length ? `<p class="map-note warn-t small" role="note">${esc(t.noFacts(s.metrics.sourcesWithoutFacts.join(', ')))}</p>` : ''}`;
}

function rulesPanel(t: T, s: RiskSummary, open: boolean, canDecide: boolean): string {
  const rows = s.rules
    .map(
      (r) =>
        `<li><label><input type="checkbox" data-map="r-rule" value="${esc(r.id)}" ${r.enabled ? 'checked' : ''} ${canDecide ? '' : 'disabled'}><b>${esc(r.id)}</b> ${esc(r.title)}</label><small class="mu">${esc(r.prerequisites.join(' · '))}</small></li>`,
    )
    .join('');
  return `<details class="rk-rules" ${open ? 'open' : ''}><summary data-action="map-r-rules">${icon('filter')}<span>${esc(t.rules)} (${String(s.rules.filter((r) => r.enabled).length)}/${String(s.rules.length)})</span></summary><p class="mu small">${esc(t.rulesIntro)}</p><ul>${rows}</ul></details>`;
}

const asEvidence = (r: Risk, e: Risk['evidence'][number]): Evidence | undefined =>
  e.file && (e.source ?? r.sourceId)
    ? {
        kind: 'STATIC_CODE',
        sourceId: e.source ?? r.sourceId,
        file: e.file,
        ...(e.line ? { line: e.line } : {}),
        confidence: 'CONFIRMED',
      }
    : undefined;

/** Le graphe d'impact : colonnes par rôle (source → donnée → état → consommateurs → aval → fonctionnalités). */
/**
 * L'affichage regroupe les méthodes, conditions et conteneurs d'un composant sous ce composant (les liens
 * passent par lui, sans doublon) : le graphe dit QUI consomme, la fiche dit par où. Les données restent entières.
 */
function grouped(impact: RiskImpact): RiskImpact {
  const ids = new Set(impact.nodes.map((n) => n.id));
  const owner = (id: string): string => {
    const m = /^(METHOD|CONDITION|CONTAINER):([^:]+):([^#.]+)[#.]/.exec(id);
    const component = m ? `COMPONENT:${m[2] ?? ''}:${m[3] ?? ''}` : '';
    return component && ids.has(component) ? component : id;
  };
  const seen = new Set<string>();
  const edges = impact.edges
    .map((e) => ({ ...e, from: owner(e.from), to: owner(e.to) }))
    .filter((e) => {
      const key = `${e.from}>${e.to}`;
      if (e.from === e.to || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { ...impact, nodes: impact.nodes.filter((n) => owner(n.id) === n.id), edges };
}

export function impactGraph(t: T, full: RiskImpact | undefined): string {
  if (!full || full.nodes.length <= 1) return `<p class="mu small">${esc(t.noImpact)}</p>`;
  const impact = grouped(full);
  const starts = new Set(
    impact.nodes.filter((n) => n.role === 'SOURCE' || n.role === 'DATA').map((n) => n.id),
  );
  const order: RiskImpactNode['role'][] = ['SOURCE', 'DATA', 'STATE', 'CONSUMER', 'DOWNSTREAM', 'FEATURE'];
  // Une rangée par rôle (source en haut, fonctionnalités en bas), repliée sur PER colonnes : le graphe tient
  // dans la largeur du panneau de détail.
  const bands = order.map((role) => impact.nodes.filter((n) => n.role === role)).filter((c) => c.length > 0);
  const W = 178;
  const H = 40;
  const GX = 22;
  const GY = 12;
  const PER = 2;
  const pos = new Map<string, { x: number; y: number }>();
  const heads: string[] = [];
  let y = 8;
  for (const band of bands) {
    heads.push(
      `<text class="rk-col" x="22" y="${String(y + 12)}">${esc(t.roles[band[0]?.role ?? ''] ?? '')}</text>`,
    );
    y += 20;
    band.forEach((n, i) => {
      pos.set(n.id, { x: 22 + (i % PER) * (W + GX), y: y + Math.floor(i / PER) * (H + GY) });
    });
    y += Math.ceil(band.length / PER) * (H + GY) + 18;
  }
  const boxBetween = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    [...pos.values()].some((p) => p.x === a.x && p.y > a.y && p.y < b.y);
  const width = 40 + PER * (W + GX) - GX;
  const height = y;
  const role: Record<string, ArrowRole> = {
    PROVEN: 'emphasis',
    INFERRED: 'dashed',
    UNCERTAIN: 'gap',
    TESTED: 'default',
    REFUTED: 'security',
  };
  const arrows = impact.edges
    .map((e, i) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      // Directement au-dessous : trait vertical. Sinon le lien descend sous sa source, rejoint le couloir à
      // gauche de la cible et y entre par le côté : il ne traverse jamais une autre boîte.
      const below = b.y > a.y && b.x === a.x && b.y - a.y <= H + GY + 40 && !boxBetween(a, b);
      const d =
        Math.abs(a.y - b.y) < 1
          ? b.x > a.x
            ? orthPath({ x: a.x + W, y: a.y + H / 2 }, { x: b.x, y: b.y + H / 2 }, 'h').d
            : orthPath({ x: a.x, y: a.y + H / 2 }, { x: b.x + W, y: b.y + H / 2 }, 'h').d
          : below
            ? `M${String(a.x + W / 2)},${String(a.y + H)} V${String(b.y)}`
            : `M${String(a.x + W / 2)},${String(b.y > a.y ? a.y + H : a.y)} V${String(b.y > a.y ? a.y + H + GY / 2 : a.y - GY / 2)} H${String(b.x - 9)} V${String(b.y + H / 2)} H${String(b.x)}`;
      const path = arrowSvg('rk', {
        d,
        role: role[e.link] ?? 'default',
        ...(e.link === 'PROVEN' && starts.has(e.from) ? { comet: i } : {}),
        data: ` data-link="${e.link}"`,
      });
      return `<g class="rk-e"><title>${esc(`${e.reason}${e.condition ? ` — ${e.condition}` : ''}`)}</title>${path}</g>`;
    })
    .join('');
  const boxes = [...pos]
    .map(([id, p]) => {
      const n = impact.nodes.find((x) => x.id === id);
      if (!n) return '';
      const label = n.name.length > 27 ? `${n.name.slice(0, 26)}…` : n.name;
      return `<g class="rk-n r-${n.role.toLowerCase()}" data-node="${esc(id)}"><title>${esc(`${n.name}${n.layer ? ` (${n.layer})` : ''}`)}</title><rect x="${String(p.x)}" y="${String(p.y)}" width="${String(W)}" height="${String(H)}" rx="6"/><text x="${String(p.x + 10)}" y="${String(p.y + 17)}">${esc(label)}</text><text class="sub" x="${String(p.x + 10)}" y="${String(p.y + 31)}">${esc(n.layer ?? t.roles[n.role] ?? '')}</text></g>`;
    })
    .join('');
  const legend = (['PROVEN', 'INFERRED', 'UNCERTAIN', 'TESTED', 'REFUTED'] as const)
    .map((k) => `<span><i class="ar-sw rk r-${role[k] ?? 'default'}"></i>${esc(t.legend[k] ?? k)}</span>`)
    .join('');
  return `<div class="rk-graph" data-rk-graph><svg viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" role="img" aria-label="${esc(t.sections.impact)}">${arrowMarkers('rk')}${heads.join('')}${arrows}${boxes}</svg></div><div class="rk-legend">${legend}</div>${impact.truncated ? `<p class="mu small">${esc(t.truncated)}</p>` : ''}${impact.blocked.length ? `<p class="mu small"><b>${esc(t.blocked)} :</b> ${esc(impact.blocked.join(' · '))}</p>` : ''}`;
}

function detail(t: T, ui: RisksUi, h: RiskHelpers): string {
  const r = ui.risk;
  if (!r) return h.detailLoading ? `<aside class="rk-detail">${h.spinner()}</aside>` : '';
  const list = (items: readonly string[]): string =>
    items.length
      ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
      : '<p class="mu small">—</p>';
  const sec = (key: keyof T['sections'], body: string): string =>
    `<section class="rk-sec" data-sec="${key}"><h4>${esc(t.sections[key])}</h4>${body}</section>`;
  const ev = r.evidence
    .map((e) => {
      const button = asEvidence(r, e);
      return `<li class="rk-ev ${e.relation.toLowerCase()}"><span class="chip">${esc(t.relation[e.relation] ?? e.relation)}</span><span class="chip mu">${esc(t.reliability[e.reliability] ?? e.reliability)}</span> ${esc(e.text)} <small class="mu">${esc(e.method)}${e.file ? ` · ${esc(e.file)}:${String(e.line ?? 1)}` : ''}</small>${button ? h.evidence(button) : ''}</li>`;
    })
    .join('');
  const verifications = r.verifications.length
    ? r.verifications
        .map(
          (v) =>
            `<li class="rk-ver"><span class="chip st-${statusTone(v.outcome)}">${esc(t.statuses[v.outcome] ?? v.outcome)}</span> <b>${esc(t.method[v.method] ?? v.method)}</b>${v.stale ? ` <span class="chip warn">${esc(t.stale)}</span>` : ''} <small class="mu">${esc(v.at.slice(0, 16).replace('T', ' '))}${v.by ? ` · ${esc(v.by)}` : ''}</small>${v.steps.length ? `<ol>${v.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}<p>${esc(v.observed)}</p>${v.expected ? `<p class="mu small">${esc(t.expected)} : ${esc(v.expected)}</p>` : ''}${v.note ? `<p class="mu small">${esc(v.note)}</p>` : ''}</li>`,
        )
        .join('')
    : `<li class="mu">${esc(t.noVerification)}</li>`;
  const last = r.verifications.filter((v) => !v.stale).at(-1);
  const actions = [
    h.canRun && r.verifiable
      ? `<button class="btn small primary" data-action="map-r-verify">${icon('play')}<span>${esc(t.simulate)}</span></button>`
      : '',
    h.canRun
      ? `<button class="btn small" data-action="map-r-form" data-form="test">${icon('check')}<span>${esc(t.declare)}</span></button>`
      : '',
    h.canDecide
      ? r.suppressed
        ? `<button class="btn small" data-action="map-r-unsuppress">${esc(t.unsuppress)}</button>`
        : `<button class="btn small ghost" data-action="map-r-form" data-form="suppress">${esc(t.suppress)}</button>`
      : '',
  ].join('');
  const form =
    ui.rForm === 'suppress'
      ? `<form class="rk-form" data-action="map-r-suppress"><label>${esc(t.reason)}<textarea name="reason" required maxlength="500" rows="2"></textarea></label><div class="rk-actions"><button class="btn small primary" type="submit">${esc(t.save)}</button><button class="btn small ghost" type="button" data-action="map-r-form" data-form="">${esc(t.cancel)}</button></div></form>`
      : ui.rForm === 'test'
        ? `<form class="rk-form" data-action="map-r-test"><label>${esc(t.outcome)} <select name="outcome"><option value="REPRODUCED">${esc(t.statuses.REPRODUCED ?? '')}</option><option value="REFUTED">${esc(t.statuses.REFUTED ?? '')}</option><option value="INCONCLUSIVE">${esc(t.statuses.INCONCLUSIVE ?? '')}</option></select></label><label>${esc(t.observed)}<textarea name="observed" required maxlength="2000" rows="2"></textarea></label><label>${esc(t.expected)}<input name="expected" maxlength="500"></label><div class="rk-actions"><button class="btn small primary" type="submit">${esc(t.save)}</button><button class="btn small ghost" type="button" data-action="map-r-form" data-form="">${esc(t.cancel)}</button></div></form>`
        : '';
  const features = r.affectedFeatures.length
    ? `<ul class="rk-feats">${r.affectedFeatures.map((f) => `<li><button class="lnk" data-action="map-feature" data-feature="${esc(f.id)}">${esc(f.name)}</button> <small class="mu">${esc(f.confidence.toLowerCase())}${f.direct ? ` · ${esc(t.direct)}` : ''}</small></li>`).join('')}</ul>`
    : '<p class="mu small">—</p>';
  const code = `<p class="mono">${esc(r.sourceId)}/${esc(r.file)}:${String(r.line)}</p>${(() => {
    const e = asEvidence(r, {
      kind: 'STATIC_FACT',
      source: r.sourceId,
      file: r.file,
      line: r.line,
      method: '',
      reliability: 'HIGH',
      relation: 'CONTEXT',
      text: '',
    });
    return e ? h.evidence(e) : '';
  })()}`;
  return `<aside class="rk-detail" data-risk="${esc(r.id)}" role="dialog" aria-label="${esc(r.title)}"><div class="rk-dh"><div><span class="chip">${esc(r.ruleId)}</span> <span class="chip sev-${sevTone(r.severity)}">${esc(t.severities[r.severity] ?? r.severity)}</span> <span class="chip st-${statusTone(r.status)}">${esc(t.statuses[r.status] ?? r.status)}</span> <span class="chip mu">${esc(pct(r.confidence))}</span><h3>${esc(r.title)}</h3></div><button class="btn small ghost icon-only" data-action="map-r-close" aria-label="${esc(t.close)}" title="${esc(t.close)}">${icon('close')}</button></div>${r.suppressed ? `<p class="map-note small" role="note">${esc(t.suppressed(r.suppressed.by, r.suppressed.reason))}</p>` : ''}${ui.rNotice ? `<p class="map-note small ok-t" role="status">${esc(ui.rNotice)}</p>` : ''}<div class="rk-actions">${actions}</div>${form}${h.detailError ? h.paneError(h.detailError) : ''}${sec('description', `<p>${esc(r.description)}</p>`)}${sec('cause', `<p>${esc(r.cause)}</p><p class="mu small">${esc(r.trigger)}</p>`)}${sec('conditions', list(r.conditions))}${sec('code', code)}${sec('evidence', `<ul class="rk-evs">${ev}</ul>`)}${sec('data', `<p class="mono">${esc(r.entity)}</p>`)}${sec('features', features)}${sec('propagation', r.propagation.length ? `<p class="rk-path">${r.propagation.map((p) => `<span>${esc(p)}</span>`).join('<i>→</i>')}</p>` : '<p class="mu small">—</p>')}${sec('impact', `${impactGraph(t, ui.riskImpact ?? r.impact)}${(ui.riskImpact ?? r.impact)?.truncated && ui.rDepth < 10 ? `<button class="btn small" data-action="map-r-expand">${esc(t.expand)}</button>` : ''}`)}${sec('verifications', `<ul class="rk-vers">${verifications}</ul>`)}${sec('results', `<p>${last ? `${esc(t.statuses[last.outcome] ?? last.outcome)} — ${esc(last.observed)}` : esc(t.noVerification)}</p>`)}${r.testPlan ? sec('plan', `<ol>${r.testPlan.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`) : ''}${sec('suggestion', `<p>${esc(r.suggestion ?? '—')}</p>`)}${sec('limits', `<h5>${esc(t.assumptions)}</h5>${list(r.assumptions)}<h5>${esc(t.unknowns)}</h5>${list(r.unknowns)}<h5>${esc(t.limits)}</h5>${list(r.limits)}`)}${sec('confidence', list(r.confidenceWhy))}</aside>`;
}

export function risksTab(ui: RisksUi, h: RiskHelpers): string {
  const t = TEXT[h.locale];
  const page = ui.risks;
  if (h.error) return `<section class="card">${h.paneError(h.error)}</section>`;
  if (!page) return `<section class="card">${h.loading ? h.spinner() : ''}</section>`;
  const s = page.summary;
  const filters = `<div class="map-filters rk-filters">${select(
    'r-category',
    t.cols[1] ?? '',
    ui.rCategory,
    RISK_CATEGORIES.map((c) => [c, t.categories[c] ?? c]),
    t.all,
  )}${select(
    'r-severity',
    t.cols[2] ?? '',
    ui.rSeverity,
    RISK_SEVERITIES.map((c) => [c, t.severities[c] ?? c]),
    t.all,
  )}${select(
    'r-status',
    t.cols[4] ?? '',
    ui.rStatus,
    RISK_STATUSES.map((c) => [c, t.statuses[c] ?? c]),
    t.allF,
  )}${select(
    'r-layer',
    t.layer,
    ui.rLayer,
    Object.keys(s.byLayer).map((c) => [c, t.layers[c] ?? c]),
    t.all,
  )}${select(
    'r-feature',
    t.feature,
    ui.rFeature,
    h.features.map((f) => [f.id, f.name]),
    t.all,
  )}${select(
    'r-conf',
    t.confidence,
    ui.rConf,
    [
      ['0.5', '50 %'],
      ['0.7', '70 %'],
      ['0.85', '85 %'],
    ],
    '0 %',
  )}<label class="pick"><input type="checkbox" data-map="r-suppressed" ${ui.rSuppressed ? 'checked' : ''}> ${esc(t.showSuppressed)}</label><input type="search" data-map="r-q" value="${esc(ui.rQuery)}" placeholder="${esc(t.search)}" aria-label="${esc(t.search)}"></div>`;
  const rows = page.items
    .map((r) => {
      const feats =
        r.affectedFeatures
          .slice(0, 3)
          .map((f) => esc(f.name))
          .join(', ') + (r.affectedFeatures.length > 3 ? ` +${String(r.affectedFeatures.length - 3)}` : '');
      return `<tr class="rk-row${ui.risk?.id === r.id ? ' sel' : ''}${r.suppressed ? ' sup' : ''}" data-risk="${esc(r.id)}"><td><button class="lnk rk-open" data-action="map-r-open" data-risk="${esc(r.id)}">${esc(r.title)}</button><div class="mu small mono">${esc(r.ruleId)} · ${esc(r.entity)}</div></td><td class="c-opt">${esc(t.categories[r.category] ?? r.category)}</td><td><span class="chip sev-${sevTone(r.severity)}">${esc(t.severities[r.severity] ?? r.severity)}</span></td><td><span class="rk-conf" style="--c:${String(Math.round(r.confidence * 100))}%">${esc(pct(r.confidence))}</span></td><td><span class="chip st-${statusTone(r.status)}">${esc(t.statuses[r.status] ?? r.status)}</span></td><td class="mono small c-opt">${esc(r.sourceId)}/${esc(r.file.split('/').pop() ?? r.file)}:${String(r.line)}</td><td class="small">${feats || '—'}</td><td class="small c-opt">${esc(seen(r.firstSeen))}${r.change ? ` <span class="chip mu">${esc(t.change[r.change] ?? r.change)}</span>` : ''}</td></tr>`;
    })
    .join('');
  const table =
    page.total === 0
      ? `<p class="mu">${esc(ui.rCategory || ui.rSeverity || ui.rStatus || ui.rLayer || ui.rFeature || ui.rConf || ui.rQuery ? t.noneFiltered : t.none)}</p>`
      : `<div class="tablewrap"><table class="rk-table"><thead><tr>${t.cols.map((c, i) => `<th class="${COL_CLASS[i] ?? ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>${h.pager('risks', page, [25, 50, 100])}`;
  return `<section class="card rk-card" data-risks><div class="card-h"><h2>${icon('alert')} ${esc(t.title)}</h2></div><p class="mu">${esc(t.intro)}</p>${header(t, s)}${rulesPanel(t, s, ui.rRules === true, h.canDecide)}${filters}<div class="rk-body${ui.risk || h.detailLoading ? ' with-detail' : ''}"><div class="rk-list">${table}</div>${detail(t, ui, h)}</div></section>`;
}

export const RISKS_CSS = `
.rk-card{display:flex;flex-direction:column;gap:12px}
.rk-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.rk-kpi{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;background:var(--qa-color-surface)}
.rk-kpi b{font-size:22px;line-height:1.1;color:var(--qa-color-text)}
.rk-kpi span{font-size:12px;color:var(--qa-color-muted)}
.rk-kpi.hi b{color:var(--qa-arch-security,#e11d48)}.rk-kpi.cor b{color:var(--qa-color-primary)}.rk-kpi.rep b{color:var(--qa-arch-db,#7c3aed)}.rk-kpi.mu b{color:var(--qa-color-muted)}
.rk-dists{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.rk-dist h4{margin:0 0 6px;font-size:12px;color:var(--qa-color-muted);font-weight:600}
.rk-bar{display:grid;grid-template-columns:110px 1fr 28px;gap:8px;align-items:center;font-size:12px;margin:3px 0}
.rk-bar i{display:block;height:8px;border-radius:4px;background:linear-gradient(90deg,var(--qa-color-primary) var(--w),var(--qa-color-primary-soft-2) var(--w))}
.rk-bar b{text-align:right;font-weight:600}
.rk-diff{margin:0}
.rk-rules{border:1px solid var(--qa-color-border);border-radius:10px;padding:6px 12px}
.rk-rules summary{display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:600}
.rk-rules ul{list-style:none;margin:6px 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:6px}
.rk-rules li{display:flex;flex-direction:column;gap:1px;font-size:12.5px}
.rk-rules label{display:flex;gap:6px;align-items:flex-start}
.rk-filters{flex-wrap:wrap}
.rk-body{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
.rk-body.with-detail{grid-template-columns:minmax(0,1.05fr) minmax(0,1fr)}
@media (max-width:1100px){.rk-body.with-detail{grid-template-columns:minmax(0,1fr)}}
.rk-table{width:100%;border-collapse:collapse;table-layout:fixed}
.rk-table th{font-size:11.5px;text-align:left;color:var(--qa-color-muted);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--qa-color-border)}
.rk-table th:first-child{width:34%}
.rk-body.with-detail .c-opt{display:none}
.rk-list{min-width:0;overflow-x:auto}
.rk-body.with-detail .rk-table{table-layout:auto}
.rk-body.with-detail .rk-table th:first-child{width:auto}
.rk-body.with-detail .rk-table td:first-child{min-width:220px}
.rk-table td:not(:first-child){overflow-wrap:normal}
.rk-table .chip{white-space:nowrap}
.rk-table td{padding:8px;border-bottom:1px solid var(--qa-color-border);vertical-align:top;font-size:12.5px;overflow-wrap:anywhere}
.rk-row.sel td{background:var(--qa-color-primary-soft-2)}.rk-row.sup td{opacity:.6}
.rk-open{font-weight:600;text-align:left}
.chip.sev-hi{background:#ffe4e6;color:#9f1239}.chip.sev-md{background:#fef3c7;color:#92400e}.chip.sev-lo{background:#f1f5f9;color:#475569}
.chip.st-cor{background:var(--qa-color-primary-soft-2);color:var(--qa-color-primary)}.chip.st-rep{background:#ede9fe;color:#5b21b6}.chip.st-ref{background:#f1f5f9;color:#334155;text-decoration:line-through}.chip.st-inc{background:#fef3c7;color:#92400e}.chip.st-pot{background:#e0f2fe;color:#075985}
.rk-conf{display:inline-block;min-width:52px;padding:1px 6px;border-radius:999px;font-size:11.5px;background:linear-gradient(90deg,var(--qa-color-primary-soft-2) var(--c),transparent var(--c));border:1px solid var(--qa-color-border)}
.rk-detail{border:1px solid var(--qa-color-border);border-radius:12px;padding:12px 14px;background:var(--qa-color-surface);display:flex;flex-direction:column;gap:10px;max-height:min(82vh,1100px);overflow:auto;position:sticky;top:12px;min-width:0}
.rk-dh{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.rk-dh h3{margin:6px 0 0;font-size:15px}
.rk-actions{display:flex;gap:8px;flex-wrap:wrap}
.rk-form{display:flex;flex-direction:column;gap:6px;border:1px dashed var(--qa-color-border);border-radius:8px;padding:8px}
.rk-form label{display:flex;flex-direction:column;gap:3px;font-size:12px}
.rk-sec h4{margin:0 0 4px;font-size:12.5px;color:var(--qa-color-muted);text-transform:none}
.rk-sec h5{margin:6px 0 2px;font-size:12px}
.rk-sec ul,.rk-sec ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;font-size:12.5px}
.rk-evs{list-style:none;padding-left:0!important}
.rk-ev{display:flex;flex-wrap:wrap;gap:4px;align-items:baseline}
.rk-ev.weakens{opacity:.85}
.rk-path{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px}
.rk-path span{padding:2px 8px;border:1px solid var(--qa-color-border);border-radius:6px;background:var(--qa-arch-canvas,#f8fafc)}
.rk-path i{font-style:normal;color:var(--qa-color-muted)}
.rk-graph{overflow:auto;max-width:100%;border:1px solid var(--qa-color-border);border-radius:10px;background-color:var(--qa-arch-canvas,#f8fafc);background-image:linear-gradient(var(--qa-arch-grid,#e2e8f0) .5px,transparent .5px),linear-gradient(90deg,var(--qa-arch-grid,#e2e8f0) .5px,transparent .5px);background-size:40px 40px;max-height:560px}
.rk-graph svg{display:block}
.rk-col{font-size:11px;font-weight:600;fill:#b45309}
.rk-n rect{fill:var(--qa-arch-ext-bg,#f1f5f9);stroke:var(--qa-arch-ext,#64748b);stroke-width:1.5}
.rk-n text{font-size:11px;fill:#0f172a}.rk-n text.sub{font-size:9.5px;fill:#64748b}
.rk-n.r-source rect{fill:#ffe4e6;stroke:#e11d48}.rk-n.r-data rect,.rk-n.r-state rect{fill:var(--qa-arch-db-bg,#efe9fe);stroke:var(--qa-arch-db,#7c3aed)}
.rk-n.r-consumer rect{fill:var(--qa-arch-fe-bg,#e0f7fb);stroke:var(--qa-arch-fe,#0891b2)}.rk-n.r-downstream rect{fill:var(--qa-arch-be-bg,#dcf6ec);stroke:var(--qa-arch-be,#059669)}
.rk-n.r-feature rect{fill:#fffbeb;stroke:#d97706;stroke-dasharray:4 3}
.rk-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11.5px;color:var(--qa-color-muted)}
.rk-legend span{display:inline-flex;gap:6px;align-items:center}
.ar-sw.rk{display:inline-block;width:22px;height:0;border-top:2px solid #64748b}
.ar-sw.rk.r-emphasis{border-color:#059669}.ar-sw.rk.r-dashed{border-top-style:dashed;border-color:#7c3aed}.ar-sw.rk.r-gap{border-top-style:dotted;border-color:#94a3b8}.ar-sw.rk.r-security{border-top-style:dashed;border-color:#e11d48}
.rk-vers{list-style:none;padding-left:0!important}
.rk-ver{border-left:3px solid var(--qa-color-border);padding-left:8px}
.rk-feats{list-style:none;padding-left:0!important}
`;
