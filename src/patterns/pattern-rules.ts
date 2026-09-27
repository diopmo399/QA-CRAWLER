import { actionLabel, type ActionCategory, type DiscoveredAction } from '../model/discovered-action.js';
import { urlText } from '../policies/keywords.js';
import type { PatternRuleHints } from '../semantics/domain-packs.js';
import type { SemanticDictionary } from '../semantics/semantic-dictionary.js';
import type { DetectedPattern, UiPattern } from './ui-pattern.js';

/**
 * Intérêt d'une action selon le motif de l'écran : un nombre de points, ou BLOCK
 * (jamais proposée par le moteur, en plus de la SafetyPolicy). Une règle vise un
 * concept du dictionnaire (`create`, `delete`…) ou une catégorie d'action
 * (`category:details`). `SAFETY` : rien à ajouter, la SafetyPolicy décide.
 */
export type PatternRuleValue = number | 'BLOCK' | 'SAFETY';

/**
 * TOUTES les règles « motif → action intéressante » du moteur, en un seul endroit.
 * Les packs de domaine peuvent en ajouter (patternRules), jamais en retirer un BLOCK.
 */
export const PATTERN_RULES: Readonly<Record<UiPattern, Readonly<Record<string, PatternRuleValue>>>> = {
  CRUD_LIST: {
    create: 80,
    'category:details': 60,
    view: 60,
    search: 40,
    'category:search': 40,
    filter: 30,
    'category:filter': 30,
    'category:pagination': 20,
    delete: 'BLOCK',
  },
  WIZARD: { next: 80, 'category:form-step': 40, previous: 20, cancel: -40, save: 'SAFETY' },
  ERROR_PAGE: { previous: 80, home: 60, retry: 20 },
  CREATE_FORM: { cancel: -40, save: 'SAFETY', create: 'SAFETY' },
  EDIT_FORM: { cancel: -40, save: 'SAFETY' },
  DETAIL: { edit: 30, 'category:tab': 30, previous: 10, delete: 'BLOCK' },
  SEARCH: { search: 40, 'category:search': 40, 'category:details': 30 },
  FILTER: { 'category:filter': 30, filter: 30 },
  PAGINATION: { 'category:pagination': 20 },
  CONFIRMATION_DIALOG: { cancel: 40, close: 30, confirm: 'SAFETY', delete: 'BLOCK' },
  EMPTY_STATE: { create: 50 },
  DASHBOARD: { 'category:menu': 30, 'category:navigation': 30, 'category:details': 20 },
  MASTER_DETAIL: { 'category:details': 40, edit: 20 },
  TABS: { 'category:tab': 30 },
  MENU: { 'category:menu': 20 },
  UPLOAD: { upload: 'SAFETY' },
  LOGIN: { login: 'SAFETY' },
};

export interface PatternInterest {
  /** Points ajoutés (pondérés par la confiance du motif). */
  points: number;
  /** Règles appliquées : « CRUD_LIST: create +80 ». */
  reasons: { pattern: UiPattern; rule: string; points: number }[];
  /** Une règle BLOCK s'applique : jamais proposée. */
  blocked?: { pattern: UiPattern; rule: string };
}

/** Ce que les motifs de l'écran disent d'une action. Le meilleur motif par règle compte une fois. */
export function patternInterest(
  action: DiscoveredAction,
  patterns: readonly DetectedPattern[],
  dictionary: SemanticDictionary,
  hints: PatternRuleHints = {},
): PatternInterest {
  const label = actionLabel(action);
  const url = action.href ? urlText(action.href) : undefined;
  const concepts = new Set(dictionary.conceptsIn(label, url));
  const interest: PatternInterest = { points: 0, reasons: [] };
  const applies = (rule: string): boolean =>
    rule.startsWith('category:')
      ? action.category === (rule.slice('category:'.length) as ActionCategory)
      : concepts.has(rule);
  for (const pattern of patterns) {
    const rules: Record<string, PatternRuleValue> = {
      ...hints[pattern.type],
      ...PATTERN_RULES[pattern.type],
    };
    // Les indices des packs complètent, sans remplacer un BLOCK/SAFETY intégré.
    for (const [rule, value] of Object.entries(hints[pattern.type] ?? {}))
      if (typeof rules[rule] === 'number' || rules[rule] === undefined) rules[rule] = value;
    let best: { rule: string; points: number } | undefined;
    for (const [rule, value] of Object.entries(rules)) {
      if (!applies(rule)) continue;
      if (value === 'BLOCK') {
        interest.blocked ??= { pattern: pattern.type, rule };
        continue;
      }
      if (value === 'SAFETY') continue;
      const points = Math.round(value * pattern.confidence);
      if (!best || Math.abs(points) > Math.abs(best.points)) best = { rule, points };
    }
    if (best && best.points !== 0) {
      interest.points += best.points;
      interest.reasons.push({ pattern: pattern.type, ...best });
    }
  }
  return interest;
}
