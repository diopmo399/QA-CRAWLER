import type { UiPattern } from '../patterns/ui-pattern.js';

export const GOAL_STATUSES = ['PENDING', 'ACTIVE', 'REACHED', 'UNREACHABLE', 'BLOCKED'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * Ce qu'un sous-objectif demande :
 * - locate : atteindre un écran qui parle de l'objet (URL, titre, région, fil d'Ariane) ;
 * - explore : sur cet écran, un motif précis (liste, formulaires…) ;
 * - find-action : repérer l'action qui fait le concept (créer, rechercher…) pour l'objet ;
 * - reach-pattern : arriver sur l'écran que cette action ouvre (formulaire de création…).
 */
export type GoalKind = 'mission' | 'locate' | 'explore' | 'find-action' | 'reach-pattern';

/** Une preuve observable qu'un objectif est atteint. */
export interface GoalEvidence {
  kind: 'url' | 'title' | 'heading' | 'region' | 'breadcrumb' | 'tab' | 'action' | 'pattern' | 'form';
  /** Ce qui a été vu, tel quel (court). */
  value: string;
  stateId: string;
  at: string;
}

export interface GoalState {
  id: string;
  description: string;
  status: GoalStatus;
  /** 1 (bas) … 10 (haut). */
  priority: number;
  evidence: GoalEvidence[];
  kind: GoalKind;
  /** Objectif de mission dont il fait partie (undefined pour un objectif de mission). */
  parentId?: string;
  /** Sous-objectifs à atteindre avant celui-ci. */
  dependsOn: string[];
  /** L'objet visé (« user ») et ses mots (synonymes compris). */
  subject?: string;
  /** Concept visé (create, search, edit…), pour find-action et reach-pattern. */
  concept?: string;
  /** Motifs qui prouvent l'objectif (explore, reach-pattern). */
  patterns?: UiPattern[];
  /** Mots supplémentaires donnés par la mission. */
  keywords: string[];
  /** Signatures d'actions qui y ont mené lors des runs précédents (KnowledgeBase) : un indice, jamais une preuve. */
  hints: string[];
  /** Pourquoi il est BLOCKED / UNREACHABLE. */
  reason?: string;
  reachedAt?: string;
}

/** Le plan : des objectifs fonctionnels, jamais une liste de clics. */
export interface ExplorationPlan {
  mission: string;
  goals: GoalState[];
}

export interface GoalMatch {
  goalId: string;
  /** Preuves observées sur cet écran. */
  evidence: GoalEvidence[];
  /** L'objectif est atteint sur cet écran (preuve observable suffisante). */
  reached: boolean;
  /** 0..1 : à quel point l'écran se rapproche de l'objectif (même sans l'atteindre). */
  proximity: number;
}

/** Ce que la mission demande, tel que le planner le lit. */
export interface Mission {
  name: string;
  description?: string;
  targets: { id: string; description?: string; keywords: string[]; priority?: number }[];
  /** Mots-clés d'objectif historiques (goals.keywords). */
  keywords: string[];
}

/** Description lisible d'un objectif, en anglais ou en français (plan, rapports, raisons du score). */
export function describeGoal(
  goal: Pick<GoalState, 'kind' | 'id'> & { subject?: string | undefined; concept?: string | undefined },
  language: 'en' | 'fr' = 'en',
): string {
  const subject = goal.subject ?? goal.id;
  const concept = goal.concept ?? '';
  const fr = language === 'fr';
  switch (goal.kind) {
    case 'mission':
      return concept ? `${concept} ${subject}` : fr ? `explorer ${subject}` : `explore ${subject}`;
    case 'locate':
      return fr ? `trouver « ${subject} »` : `find "${subject}"`;
    case 'explore':
      return fr ? `explorer « ${subject} » (liste, fiche)` : `explore "${subject}" (list, detail)`;
    case 'find-action':
      return fr
        ? `trouver l’action « ${concept} » pour « ${subject} »`
        : `find the "${concept}" action for "${subject}"`;
    case 'reach-pattern':
      return fr
        ? `atteindre l’écran « ${concept} » pour « ${subject} »`
        : `reach the "${concept}" screen for "${subject}"`;
  }
}
