import type { BusinessIdentifier, BusinessStatus } from './model.js';

/**
 * LA MÉMOIRE DES ENTITÉS d'un enregistrement : les entités créées (ou ouvertes) pendant le parcours,
 * avec leur identifiant. Une saisie plus loin (« 12345 ») est comparée à cette mémoire : même
 * empreinte, même valeur → la saisie RÉFÉRENCE l'entité ($created.demande.id).
 *
 * Seules les interprétations CONFIRMED et PROBABLE y entrent : une hypothèse faible ne devient
 * jamais une référence.
 */
export interface EntityRecord {
  entity: string;
  /** $created.demande.id */
  reference: string;
  identifier: BusinessIdentifier;
  status: Extract<BusinessStatus, 'CONFIRMED' | 'PROBABLE'>;
  confidence: number;
  /** L'événement métier qui l'a produite. */
  eventId: string;
}

export class EntityMemory {
  private readonly records: EntityRecord[] = [];

  /** L'entité créée : sa référence runtime ($created.<entité>.id, puis .id2… si plusieurs). */
  remember(input: Omit<EntityRecord, 'reference'>): EntityRecord {
    const same = this.records.filter((record) => record.entity === input.entity).length;
    const reference = `$created.${input.entity}.id${same === 0 ? '' : String(same + 1)}`;
    const record: EntityRecord = { ...input, reference };
    this.records.push(record);
    return record;
  }

  /**
   * Les entités dont l'identifiant correspond à une valeur observée (une saisie, un texte, un
   * segment d'URL) : par empreinte salée, ou par valeur quand elle est connue.
   */
  match(value: { digest?: string; value?: string }): { record: EntityRecord; match: string }[] {
    const found: { record: EntityRecord; match: string }[] = [];
    for (const record of this.records) {
      if (value.digest && record.identifier.digest && value.digest === record.identifier.digest)
        found.push({ record, match: 'same salted digest' });
      else if (
        value.value !== undefined &&
        record.identifier.value !== undefined &&
        same(value.value, record.identifier.value)
      )
        found.push({ record, match: 'same value' });
    }
    return found;
  }

  /** L'entité dont l'identifiant apparaît dans un texte (« Demande 12345 », /demandes/12345). */
  foundIn(text: string, digest?: (value: string) => string): { record: EntityRecord; match: string }[] {
    const tokens = identifierTokens(text);
    const found: { record: EntityRecord; match: string }[] = [];
    for (const record of this.records) {
      const { value, digest: recorded } = record.identifier;
      if (value !== undefined && tokens.some((token) => same(token, value)))
        found.push({ record, match: `"${value}" in "${text.slice(0, 60)}"` });
      else if (recorded && digest && tokens.some((token) => digest(token) === recorded))
        found.push({ record, match: `an identifier of "${text.slice(0, 60)}" has the same salted digest` });
    }
    return found;
  }

  get all(): readonly EntityRecord[] {
    return this.records;
  }
}

/** Les jetons qui peuvent être un identifiant : nombres (≥ 3 chiffres), codes (DEM-2026-001), uuid. */
export function identifierTokens(text: string): string[] {
  const tokens = text.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Z]{2,}[-_][A-Z0-9][A-Z0-9_-]*|\d{3,}/gi,
  );
  return [...new Set(tokens ?? [])].slice(0, 20);
}

function same(a: string, b: string): boolean {
  return a.trim().replace(/^#/, '').toLowerCase() === b.trim().replace(/^#/, '').toLowerCase();
}
