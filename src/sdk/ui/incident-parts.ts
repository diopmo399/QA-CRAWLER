import type { Incident, Layer, RelationStatus, SourceLocation } from '../core/incident-contracts.js';
import {
  relatedKeys,
  selectionState,
  type SelectionKind,
  type WorkspaceLinks,
  type WorkspaceSelection,
} from './incident-links.js';
import { esc } from './view.js';

/**
 * LES PRIMITIVES PARTAGÉES DE L'ESPACE D'INVESTIGATION. Chaque vue (traçabilité frontend, graphe,
 * chronologie, code, diagnostic) reçoit le même contexte et utilise les mêmes briques : élément
 * sélectionnable, statut de relation, lien vers le code, puces de preuves, états de panneau (chargement,
 * vide, erreur, accès refusé), bandeau « Données de démonstration ». Les textes de ces briques sont ici ;
 * ceux de chaque vue restent dans sa propre table fr/en.
 */
export type Lang = 'fr' | 'en';

export interface WorkspaceContext {
  incident: Incident;
  lang: Lang;
  /** Ce qui est sélectionné, partagé par toutes les vues. */
  selection?: WorkspaceSelection;
  links: WorkspaceLinks;
  /** Les clés reliées à la sélection (calculées une fois par dessin). */
  related: ReadonlySet<string>;
  /** Données de démonstration : jamais présentées comme un diagnostic réel. */
  demo: boolean;
  /** Les droits de la personne (RUN, DECIDE, PUBLISH, RUN_WRITES). */
  can: (right: 'RUN' | 'DECIDE' | 'PUBLISH' | 'RUN_WRITES') => boolean;
}

export function workspaceContext(input: Omit<WorkspaceContext, 'related'>): WorkspaceContext {
  return { ...input, related: relatedKeys(input.links, input.selection) };
}

const TEXT = {
  fr: {
    relations: {
      OBSERVED: 'Observée',
      STATICALLY_RESOLVED: 'Lue dans le code',
      INFERRED: 'Déduite',
      UNKNOWN: 'Inconnue',
    } as Record<RelationStatus, string>,
    relationHints: {
      OBSERVED: 'vue pendant l’exécution',
      STATICALLY_RESOLVED: 'résolue dans le code, sans ambiguïté',
      INFERRED: 'déduite, à vérifier',
      UNKNOWN: 'lien non établi',
    } as Record<RelationStatus, string>,
    layers: {
      FRONTEND: 'Frontend',
      BFF: 'BFF',
      BACKEND: 'Backend',
      DATABASE: 'Base de données',
      NETWORK: 'Réseau',
      TEST_DATA: 'Données de test',
      ENVIRONMENT: 'Environnement',
      UNKNOWN: 'Inconnue',
    } as Record<Layer, string>,
    openCode: (file: string, line: number) => `Ouvrir ${file}, ligne ${String(line)}`,
    evidence: (count: number) => `${String(count)} preuve(s)`,
    unresolved: (ref: string) => `${ref} — référence sans élément sélectionnable dans l’investigation`,
    loading: 'Chargement…',
    empty: 'Rien à afficher pour l’instant.',
    error: 'Le chargement a échoué.',
    retry: 'Réessayer',
    denied: 'Votre rôle ne permet pas de voir ce panneau.',
    demo: 'Données de démonstration',
    demoHint: 'Un incident fictif pour découvrir l’espace d’investigation : ce n’est pas un diagnostic réel.',
    legend: 'Légende des relations',
  },
  en: {
    relations: {
      OBSERVED: 'Observed',
      STATICALLY_RESOLVED: 'Read in the code',
      INFERRED: 'Inferred',
      UNKNOWN: 'Unknown',
    } as Record<RelationStatus, string>,
    relationHints: {
      OBSERVED: 'seen during the run',
      STATICALLY_RESOLVED: 'resolved in the code, unambiguous',
      INFERRED: 'inferred, to be checked',
      UNKNOWN: 'link not established',
    } as Record<RelationStatus, string>,
    layers: {
      FRONTEND: 'Frontend',
      BFF: 'BFF',
      BACKEND: 'Backend',
      DATABASE: 'Database',
      NETWORK: 'Network',
      TEST_DATA: 'Test data',
      ENVIRONMENT: 'Environment',
      UNKNOWN: 'Unknown',
    } as Record<Layer, string>,
    openCode: (file: string, line: number) => `Open ${file}, line ${String(line)}`,
    evidence: (count: number) => `${String(count)} evidence item(s)`,
    unresolved: (ref: string) => `${ref} — reference with no selectable item in the investigation`,
    loading: 'Loading…',
    empty: 'Nothing to show yet.',
    error: 'Loading failed.',
    retry: 'Retry',
    denied: 'Your role does not allow you to see this panel.',
    demo: 'Demonstration data',
    demoHint: 'A fictional incident to discover the investigation workspace: this is not a real diagnosis.',
    legend: 'Relation legend',
  },
};

export const partsText = (lang: Lang): (typeof TEXT)['fr'] => TEXT[lang];

/**
 * Les attributs d'un élément sélectionnable : le clic (`ws-select`), son état (`data-ws-state`) et
 * `aria-pressed` pour les lecteurs d'écran ; la classe d'état vient de selectionClass(). À poser sur un
 * <button> ou un élément focusable (`tabindex="0"` et `role="button"` sont ajoutés si `focusable`).
 */
export function selectable(
  ctx: WorkspaceContext,
  kind: SelectionKind,
  id: string,
  focusable = false,
): string {
  const state = selectionState(ctx.related, ctx.selection, kind, id);
  return `data-action="ws-select" data-kind="${kind}" data-ref="${esc(id)}" data-ws-state="${state}" aria-pressed="${String(state === 'selected')}"${focusable ? ' tabindex="0" role="button"' : ''}`;
}

/** La classe CSS d'état de sélection, à ajouter à la classe de l'élément. */
export function selectionClass(ctx: WorkspaceContext, kind: SelectionKind, id: string): string {
  const state = selectionState(ctx.related, ctx.selection, kind, id);
  return state === 'none' ? '' : `ws-${state}`;
}

/** Le statut d'une relation, en badge (couleur et style de trait identiques à ceux du graphe). */
export function relationBadge(lang: Lang, status: RelationStatus): string {
  const t = partsText(lang);
  return `<span class="ws-rel ws-rel-${status.toLowerCase()}" title="${esc(t.relationHints[status])}">${esc(t.relations[status])}</span>`;
}

/** La légende des quatre statuts de relation. */
export function relationLegend(lang: Lang): string {
  const t = partsText(lang);
  return `<ul class="ws-legend" aria-label="${esc(t.legend)}">${(
    ['OBSERVED', 'STATICALLY_RESOLVED', 'INFERRED', 'UNKNOWN'] as const
  )
    .map(
      (status) =>
        `<li><span class="ws-line ws-line-${status.toLowerCase()}" aria-hidden="true"></span><b>${esc(t.relations[status])}</b> <small>${esc(t.relationHints[status])}</small></li>`,
    )
    .join('')}</ul>`;
}

/** Un lien vers l'explorateur de code (`ws-code`), sur une localisation du périmètre. */
export function sourceLink(lang: Lang, source: SourceLocation, text?: string): string {
  const t = partsText(lang);
  return `<button type="button" class="lnk ws-src" data-action="ws-code" data-app="${esc(source.applicationId)}" data-file="${esc(source.file)}" data-line="${String(source.line)}"${source.symbolId ? ` data-symbol="${esc(source.symbolId)}"` : ''} title="${esc(t.openCode(source.file, source.line))}"><code>${esc(text ?? `${source.file.split('/').at(-1) ?? source.file}:${String(source.line)}`)}</code></button>`;
}

/**
 * Les preuves d'un élément : une puce cliquable par référence qui désigne quelque chose de l'investigation
 * (requête, preuve, symbole, vérification — d'après l'index des liens) ; une référence qui ne désigne rien
 * de sélectionnable (l'identifiant d'une reproduction, une trace externe) reste une puce de texte.
 */
export function evidenceChips(ctx: WorkspaceContext, refs: readonly string[], max = 4): string {
  if (refs.length === 0) return '';
  const shown = refs.slice(0, max);
  const more = refs.length - shown.length;
  const t = partsText(ctx.lang);
  return `<span class="ws-chips" aria-label="${esc(t.evidence(refs.length))}">${shown
    .map((ref) => {
      const label = esc(ref.split(/[:#/]/).filter(Boolean).at(-1) ?? ref);
      const key = ctx.links.refs.get(ref);
      const separator = key?.indexOf(':') ?? -1;
      if (!key || separator < 0)
        return `<span class="ws-chip static" title="${esc(t.unresolved(ref))}">${label}</span>`;
      const kind = key.slice(0, separator) as SelectionKind;
      const id = key.slice(separator + 1);
      return `<button type="button" class="ws-chip ${selectionClass(ctx, kind, id)}" ${selectable(ctx, kind, id)} title="${esc(ref)}">${label}</button>`;
    })
    .join('')}${more > 0 ? `<span class="ws-chip more">+${String(more)}</span>` : ''}</span>`;
}

export type PanelState = 'loading' | 'empty' | 'error' | 'denied';

/** Les états d'un panneau : chargement (aria-busy), vide, erreur (role=alert, réessayer), accès refusé. */
export function panelState(lang: Lang, state: PanelState, detail?: string, retryAction?: string): string {
  const t = partsText(lang);
  switch (state) {
    case 'loading':
      return `<div class="ws-state" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(detail ?? t.loading)}</p></div>`;
    case 'empty':
      return `<div class="ws-state"><p class="mu">${esc(detail ?? t.empty)}</p></div>`;
    case 'error':
      return `<div class="ws-state" role="alert"><p class="err">${esc(detail ?? t.error)}</p>${retryAction ? `<button type="button" class="btn small" data-action="${esc(retryAction)}">${esc(t.retry)}</button>` : ''}</div>`;
    case 'denied':
      return `<div class="ws-state"><p class="mu">${esc(detail ?? t.denied)}</p></div>`;
  }
}

/** Le bandeau des données de démonstration : toujours visible quand `demo` est vrai. */
export function demoBanner(ctx: WorkspaceContext): string {
  if (!ctx.demo) return '';
  const t = partsText(ctx.lang);
  return `<p class="ws-demo" role="note"><b>${esc(t.demo)}</b><span>${esc(t.demoHint)}</span></p>`;
}

/** Les styles des primitives (s'ajoutent à DASHBOARD_CSS ; jetons de couleur du thème, clair et sombre). */
export const INCIDENT_PARTS_CSS = `
.ws-selected{outline:2px solid var(--qa-color-primary);outline-offset:1px;border-radius:6px}
.ws-related{background:color-mix(in srgb,var(--qa-color-primary) 10%,transparent);border-radius:6px}
.ws-dimmed{opacity:.45}
.ws-rel{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.ws-rel-observed{background:color-mix(in srgb,var(--qa-color-primary) 14%,transparent);color:color-mix(in srgb,var(--qa-color-primary) 62%,var(--qa-color-text))}
.ws-rel-statically_resolved{background:color-mix(in srgb,var(--qa-color-success) 16%,transparent);color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))}
.ws-rel-inferred{background:color-mix(in srgb,var(--qa-color-warning) 18%,transparent);color:color-mix(in srgb,var(--qa-color-warning) 62%,var(--qa-color-text))}
.ws-rel-unknown{background:color-mix(in srgb,var(--qa-color-danger) 14%,transparent);color:color-mix(in srgb,var(--qa-color-danger) 62%,var(--qa-color-text))}
.ws-legend{display:flex;flex-wrap:wrap;gap:6px 18px;list-style:none;margin:0;padding:0;font-size:13px}
.ws-legend li{display:flex;align-items:center;gap:6px}
.ws-line{display:inline-block;width:28px;border-top:2px solid}
.ws-line-observed{border-color:var(--qa-color-primary)}
.ws-line-statically_resolved{border-color:var(--qa-color-success)}
.ws-line-inferred{border-color:var(--qa-color-warning);border-top-style:dashed}
.ws-line-unknown{border-color:var(--qa-color-danger);border-top-style:dotted}
.ws-src{padding:0;font-size:12px}
.ws-chips{display:inline-flex;flex-wrap:wrap;gap:4px}
.ws-chip{font:12px var(--qa-font-family-mono);padding:1px 6px;border-radius:6px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface);color:var(--qa-color-text);cursor:pointer}
.ws-chip.more,.ws-chip.static{cursor:default;color:var(--qa-color-muted)}
.ws-chip.static{border-style:dashed}
.ws-state{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:16px}
.ws-demo{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0;padding:10px 14px;border-radius:10px;border:1px dashed var(--qa-color-warning);background:color-mix(in srgb,var(--qa-color-warning) 10%,transparent)}
`;
