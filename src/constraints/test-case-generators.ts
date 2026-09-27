import type { DiscoveredForm } from '../forms/form-model.js';
import type { FieldConstraints, FormConstraints } from './constraints.js';

/** Une valeur de test aux bornes d'une contrainte. */
export interface BoundaryTestCase {
  value: string;
  valid: boolean;
  /** min, min+1, max-1, max, below-min, above-max, min-length, too-short, too-long… */
  kind: string;
}

export interface BoundaryValueGenerator {
  generate(constraints: FieldConstraints): BoundaryTestCase[];
}

/**
 * Valeurs aux bornes : min = 18, max = 65 → valides 18, 19, 64, 65 ; invalides 17, 66.
 * Longueur 3..20 → 2, 3, 4, 19, 20, 21 caractères. Au plus `maxCases` valeurs.
 */
export class SimpleBoundaryValueGenerator implements BoundaryValueGenerator {
  constructor(private readonly maxCases = 8) {}

  generate(constraints: FieldConstraints): BoundaryTestCase[] {
    const cases: BoundaryTestCase[] = [];
    const add = (value: string, valid: boolean, kind: string): void => {
      if (!cases.some((entry) => entry.value === value)) cases.push({ value, valid, kind });
    };
    const step = constraints.step ?? 1;
    const { min, max, minLength, maxLength } = constraints;
    if (min !== undefined) {
      add(number(min - step), false, 'below-min');
      add(number(min), true, 'min');
      if (max === undefined || min + step <= max) add(number(min + step), true, 'min+1');
    }
    if (max !== undefined) {
      if (min === undefined || max - step >= min) add(number(max - step), true, 'max-1');
      add(number(max), true, 'max');
      add(number(max + step), false, 'above-max');
    }
    if (minLength !== undefined && minLength > 0) {
      if (minLength > 1) add('x'.repeat(minLength - 1), false, 'too-short');
      add('x'.repeat(minLength), true, 'min-length');
      add('x'.repeat(minLength + 1), true, 'min-length+1');
    }
    if (maxLength !== undefined) {
      add('x'.repeat(Math.max(1, maxLength - 1)), true, 'max-length-1');
      add('x'.repeat(maxLength), true, 'max-length');
      add('x'.repeat(maxLength + 1), false, 'too-long');
    }
    // Les invalides d'abord (les plus parlants), puis les valides, dans la limite.
    return [...cases.filter((entry) => !entry.valid), ...cases.filter((entry) => entry.valid)].slice(
      0,
      this.maxCases,
    );
  }
}

export interface EquivalencePartition {
  /** « <18 », « 18..65 », « >65 », « too short »… */
  name: string;
  valid: boolean;
  /** La valeur qui représente toute la partition. */
  representative: string;
}

/**
 * Partitions d'équivalence : age 18..65 → <18, 18..65, >65, une valeur par partition
 * (inutile de tester 100 valeurs semblables).
 */
export function equivalencePartitions(constraints: FieldConstraints): EquivalencePartition[] {
  const partitions: EquivalencePartition[] = [];
  const { min, max, minLength, maxLength } = constraints;
  if (min !== undefined || max !== undefined) {
    const low = min ?? (max ?? 0) - 100;
    const high = max ?? low + 100;
    if (min !== undefined)
      partitions.push({
        name: `<${number(min)}`,
        valid: false,
        representative: number(min - Math.max(1, Math.round((high - low) / 10) || 1)),
      });
    partitions.push({
      name: `${number(low)}..${number(high)}`,
      valid: true,
      representative: number(Math.round((low + high) / 2)),
    });
    if (max !== undefined)
      partitions.push({
        name: `>${number(max)}`,
        valid: false,
        representative: number(max + Math.max(1, Math.round((high - low) / 10) || 1)),
      });
  } else if (minLength !== undefined || maxLength !== undefined) {
    const shortest = minLength ?? 0;
    const longest = maxLength ?? shortest + 20;
    if (shortest > 1)
      partitions.push({
        name: `length <${shortest}`,
        valid: false,
        representative: 'x'.repeat(Math.floor(shortest / 2)),
      });
    partitions.push({
      name: `length ${shortest}..${longest}`,
      valid: true,
      representative: 'x'.repeat(Math.max(1, Math.round((shortest + longest) / 2))),
    });
    if (maxLength !== undefined)
      partitions.push({ name: `length >${longest}`, valid: false, representative: 'x'.repeat(longest * 2) });
  }
  if (constraints.enum && constraints.enum.length > 0) {
    partitions.push({ name: 'listed value', valid: true, representative: constraints.enum[0] ?? '' });
  }
  if (constraints.format === 'email') {
    partitions.push({ name: 'well-formed e-mail', valid: true, representative: 'qa@example.test' });
    partitions.push({ name: 'malformed e-mail', valid: false, representative: 'invalid-email' });
  }
  if (constraints.required) partitions.push({ name: 'empty', valid: false, representative: '' });
  return partitions;
}

/** Un cas de formulaire généré : une valeur par champ, et ce qu'on attend. */
export interface GeneratedFormCase {
  id: string;
  /** « age: below-min (17) », « all fields valid ». */
  description: string;
  values: Record<string, string>;
  /** ACCEPTED : aucun champ refusé ; REJECTED : le champ visé doit être refusé. */
  expectation: 'ACCEPTED' | 'REJECTED';
  /** Champ qui varie (les autres gardent une valeur valide). */
  fieldId?: string;
}

export interface PropertyTestGenerator {
  generate(form: DiscoveredForm, constraints: FormConstraints, budget: number): GeneratedFormCase[];
}

/**
 * Base du property-based testing, sans dépendance : un cas « tout valide », puis un
 * facteur à la fois — chaque champ prend ses représentants de partitions et ses
 * bornes, les autres champs gardent une valeur valide. Les propriétés vérifiées :
 * une valeur valide est acceptée, une valeur invalide est refusée. Borné par `budget`,
 * les cas invalides (les plus parlants) d'abord, champ après champ.
 */
export class OneFactorPropertyTestGenerator implements PropertyTestGenerator {
  constructor(private readonly boundaries: BoundaryValueGenerator = new SimpleBoundaryValueGenerator()) {}

  generate(form: DiscoveredForm, constraints: FormConstraints, budget: number): GeneratedFormCase[] {
    const fields = form.fields.filter(
      (field) => constraints[field.id] !== undefined && !field.sensitive && !field.payment,
    );
    const valid: Record<string, string> = {};
    for (const field of fields) {
      const representative = equivalencePartitions(constraints[field.id] ?? {}).find(
        (partition) => partition.valid,
      )?.representative;
      if (representative !== undefined) valid[field.id] = representative;
    }
    const cases: GeneratedFormCase[] = [];
    if (Object.keys(valid).length > 0)
      cases.push({
        id: 'all-valid',
        description: 'all fields valid',
        values: { ...valid },
        expectation: 'ACCEPTED',
      });
    const perField = fields.map((field) => {
      const own = constraints[field.id] ?? {};
      const variants = new Map<string, { kind: string; valid: boolean }>();
      for (const partition of equivalencePartitions(own))
        if (!variants.has(partition.representative))
          variants.set(partition.representative, { kind: partition.name, valid: partition.valid });
      for (const boundary of this.boundaries.generate(own))
        if (!variants.has(boundary.value))
          variants.set(boundary.value, { kind: boundary.kind, valid: boundary.valid });
      const ordered = [...variants.entries()].sort((a, b) => Number(a[1].valid) - Number(b[1].valid));
      return { field, variants: ordered.filter(([value]) => value !== valid[field.id]) };
    });
    // Un tour par champ, puis le suivant : chaque champ a sa chance avant que le budget ne s'épuise.
    for (let round = 0; cases.length < budget; round++) {
      let added = false;
      for (const { field, variants } of perField) {
        const variant = variants[round];
        if (!variant || cases.length >= budget) continue;
        const [value, { kind, valid: isValid }] = variant;
        const label = (field.label ?? field.name ?? field.id).replace(/^\*\s*|\s*\*$/g, '');
        cases.push({
          id: `${field.id}:${kind}`,
          description: `${label}: ${kind} (${value.length > 12 ? `${value.length} chars` : JSON.stringify(value)})`,
          values: { ...valid, [field.id]: value },
          expectation: isValid ? 'ACCEPTED' : 'REJECTED',
          fieldId: field.id,
        });
        added = true;
      }
      if (!added) break;
    }
    return cases.slice(0, budget);
  }
}

function number(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
