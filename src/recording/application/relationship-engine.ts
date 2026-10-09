import { round } from '../business/signals.js';
import { statusOf, type InterpretationStatus, type Relationship, type RelationshipType } from './model.js';

/**
 * RELATIONSHIP ENGINE : les relations entre éléments observés (task, espace de travail, contexte,
 * entité, action). Une relation n'existe que si des preuves la portent : sans preuve, rien. Une
 * relation qui pourrait viser plusieurs cibles reste INCERTAINE avec ses candidats — jamais un choix.
 * Une IA (facultative) peut seulement choisir parmi ces candidats ; le choix est revalidé et plafonné.
 */
export const AI_RELATION_CAP = 0.7;

export interface RelationInput {
  type: RelationshipType | (string & {});
  source: string;
  target: string;
  confidence: number;
  reason: string;
  evidenceIds: string[];
  actionIds?: string[];
  /** Vu tel quel (un enregistrement lu, un changement de contexte) plutôt que déduit. */
  observed?: boolean;
  candidates?: string[];
}

export class RelationshipEngine {
  private readonly relations: Relationship[] = [];

  constructor(
    /** Des relations incertaines tranchées (IA facultative) : `${source}|${type}` → cible candidate. */
    private readonly decisions: ReadonlyMap<string, string> = new Map(),
  ) {}

  add(input: RelationInput): Relationship | undefined {
    if (input.evidenceIds.length === 0) return undefined;
    const candidates =
      input.candidates && input.candidates.length > 1 ? [...new Set(input.candidates)] : undefined;
    const decision = candidates ? this.decisions.get(`${input.source}|${input.type}`) : undefined;
    const chosen = decision !== undefined && candidates?.includes(decision) ? decision : undefined;
    const existing = this.relations.find(
      (relation) =>
        relation.type === input.type &&
        relation.source === input.source &&
        relation.target === (chosen ?? input.target),
    );
    if (existing) {
      // La même relation vue encore : ses preuves s'ajoutent, la confiance garde la plus forte.
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...input.evidenceIds])];
      existing.actionIds = [...new Set([...existing.actionIds, ...(input.actionIds ?? [])])];
      existing.confidence = Math.max(existing.confidence, round(input.confidence));
      existing.status = this.status(
        existing.confidence,
        existing.evidenceIds.length,
        input.observed,
        !!existing.candidates,
      );
      return existing;
    }
    const confidence = round(
      chosen
        ? Math.min(AI_RELATION_CAP, input.confidence)
        : candidates
          ? Math.min(input.confidence, 0.5)
          : input.confidence,
    );
    const relation: Relationship = {
      id: `rel${String(this.relations.length + 1)}`,
      type: input.type,
      source: input.source,
      target: chosen ?? input.target,
      confidence,
      status: chosen
        ? 'DEDUCED'
        : this.status(confidence, input.evidenceIds.length, input.observed, !!candidates),
      reason: chosen ? `${input.reason}; AI chose ${chosen} among the candidates` : input.reason,
      evidenceIds: [...new Set(input.evidenceIds)],
      actionIds: [...new Set(input.actionIds ?? [])],
      ...(candidates ? { candidates } : {}),
      analyzer: chosen ? 'AI_PROPOSAL' : 'DETERMINISTIC',
    };
    this.relations.push(relation);
    return relation;
  }

  private status(
    confidence: number,
    evidence: number,
    observed: boolean | undefined,
    uncertain: boolean,
  ): InterpretationStatus {
    return uncertain ? 'UNCERTAIN' : statusOf(confidence, evidence, observed);
  }

  get all(): readonly Relationship[] {
    return this.relations;
  }

  of(key: string): Relationship[] {
    return this.relations.filter((relation) => relation.source === key || relation.target === key);
  }
}
