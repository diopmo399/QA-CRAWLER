import type { ObservedKnowledgeContext } from '../knowledge/knowledge-model.js';

/**
 * CONTEXTE D'UNE CONNAISSANCE : dans quelles conditions une observation a été faite.
 * « /admin/users est accessible » (ADMIN) et « /admin/users répond 403 » (USER) ne se
 * contredisent pas : ce sont deux contextes. Un contexte différent ne rend pas une
 * connaissance fausse, il la rend moins applicable (contextSimilarity < 1).
 *
 * Représentation compacte : la connaissance garde le contexte de sa DERNIÈRE observation
 * (lastContext), pas une ligne par combinaison.
 */
export interface KnowledgeContext extends ObservedKnowledgeContext {
  applicationId: string;
}

export type ViewportClass = NonNullable<ObservedKnowledgeContext['viewportClass']>;

/** Le contexte d'une observation passée : environnement, acteur, version, navigateur, classe d'écran. */
export type ObservedContext = ObservedKnowledgeContext;

/** mobile < 768 px ≤ tablet < 1200 px ≤ desktop. */
export function viewportClassOf(width: number): ViewportClass {
  return width < 768 ? 'mobile' : width < 1200 ? 'tablet' : 'desktop';
}

/** Poids d'une différence : combien la connaissance reste applicable quand cette dimension change. */
export const CONTEXT_WEIGHTS = {
  environment: 0.7,
  actor: 0.5,
  version: 0.85,
  browser: 0.95,
  viewportClass: 0.9,
} as const;

export type ContextDimension = keyof typeof CONTEXT_WEIGHTS;

export interface ContextSimilarity {
  /** 0..1 : 1 = même contexte (ou aucune différence connue). */
  score: number;
  /** Dimensions différentes : « actor admin ≠ user ». */
  differences: { dimension: ContextDimension; observed: string; current: string }[];
  /** Dimensions inconnues d'un côté (sans effet sur le score, mais dites). */
  unknown: ContextDimension[];
}

/**
 * Similarité déterministe entre le contexte d'une observation passée et le contexte
 * courant : produit des poids des dimensions différentes. Une dimension inconnue d'un
 * côté ne pénalise pas (l'historique chargé avant cette version n'a pas de contexte),
 * mais elle est signalée.
 */
export function contextSimilarity(
  observed: ObservedContext | undefined,
  current: KnowledgeContext,
): ContextSimilarity {
  const differences: ContextSimilarity['differences'] = [];
  const unknown: ContextDimension[] = [];
  let score = 1;
  for (const dimension of Object.keys(CONTEXT_WEIGHTS) as ContextDimension[]) {
    const before = observed?.[dimension];
    const now = current[dimension];
    if (before === undefined || now === undefined) {
      if (before !== now) unknown.push(dimension);
      continue;
    }
    if (before !== now) {
      differences.push({ dimension, observed: before, current: now });
      score *= CONTEXT_WEIGHTS[dimension];
    }
  }
  return { score: Math.round(score * 1000) / 1000, differences, unknown };
}
