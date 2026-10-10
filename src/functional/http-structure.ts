import { valueDigest } from '../forms/state/value-digest.js';

/**
 * ANALYSEUR STRUCTUREL HTTP : la STRUCTURE d'une requête (paramètres d'URL, corps JSON imbriqué),
 * jamais ses données. Aucun nom de champ, d'endpoint ni de format propre à une application : les
 * rôles (critère, groupe logique, tri, pagination, option, contexte) se reconnaissent à la FORME —
 * un objet qui porte une propriété, un opérateur et une valeur ; un opérateur logique à côté d'un
 * tableau d'objets ; une direction de tri ; deux petits entiers dont l'un est une taille de page.
 *
 * Les noms de champs (le schéma) sont gardés ; les VALEURS ne le sont que lorsqu'elles sont des
 * jetons de structure (opérateurs, directions, codes en capitales, noms de propriétés) ou de petits
 * nombres / booléens. Toute autre valeur n'est qu'une EMPREINTE salée (exacte et « pliée » : casse,
 * espaces, accents), comparable à une saisie. Une clé sensible n'est jamais lue.
 */
export type ValueKind = 'string' | 'number' | 'boolean' | 'null';

export interface StructuredValue {
  type: ValueKind;
  /** La valeur en clair : seulement un jeton de structure, un petit nombre, un booléen, null. */
  clear?: string | number | boolean | null;
  /** Empreinte salée exacte (valeur rognée) et pliée (casse, espaces, accents). */
  digest?: string;
  folded?: string;
  /** VALUE : masquée (une donnée) ; SENSITIVE_KEY : jamais lue ; USER_INPUT : une saisie, re-masquée. */
  masked?: 'VALUE' | 'SENSITIVE_KEY' | 'USER_INPUT';
  length?: number;
}

export interface StructureLeaf {
  /** Chemin complet (condition.conditions[1].value, ?page). Les index de tableau sont gardés. */
  path: string;
  source: 'QUERY' | 'BODY';
  value: StructuredValue;
}

export interface Criterion {
  /** L'objet du critère (condition.conditions[0]) ou la feuille (filters.name, ?q). */
  path: string;
  source: 'QUERY' | 'BODY';
  /** La propriété visée : un nom de propriété porté en VALEUR (forme propriété/opérateur/valeur) ou la clé. */
  property: string;
  propertyFrom: 'VALUE' | 'KEY';
  operator?: string;
  /** Le chemin de la valeur comparée (…value) et la valeur (masquée). */
  valuePath: string;
  value: StructuredValue;
  /** Le groupe logique qui le contient (son chemin). */
  group?: string;
  /** STRUCTURE : forme propriété/opérateur/valeur ; IMPLICIT : une clé → une valeur masquée. */
  form: 'STRUCTURE' | 'IMPLICIT';
  confidence: number;
}

export interface LogicalGroup {
  path: string;
  operator: string;
  childrenPath: string;
  children: number;
  parent?: string;
}

export interface SortSpec {
  path: string;
  property?: string;
  direction: string;
}

export interface PaginationSpec {
  index?: { path: string; value: number };
  size?: { path: string; value: number };
  confidence: number;
  evidence: string[];
}

export interface HttpStructure {
  contentType?: string;
  leaves: StructureLeaf[];
  criteria: Criterion[];
  groups: LogicalGroup[];
  sort: SortSpec[];
  pagination?: PaginationSpec;
  /** Booléens : options d'inclusion, indicateurs. */
  options: StructureLeaf[];
  /** Le reste : paramètres de contexte, métadonnées. */
  context: StructureLeaf[];
  /** Trop grand : la structure est tronquée (feuilles, profondeur). */
  truncated: boolean;
}

/** Les vocabulaires de PROTOCOLE (logique, comparaison, tri) : génériques, jamais propres à une application. */
const LOGICAL = /^(and|or|not|nor|et|ou|&&|\|\|)$/i;
const OPERATOR =
  /^(eq|equals?|equal_?to|ne|n_?eq|not_?equals?|gt|gte|ge|lt|lte|le|in|nin|not_?in|like|ilike|not_?like|contains?|not_?contains|starts?_?with|ends?_?with|between|is_?null|is_?not_?null|exists|match(es)?|egal|egale|contient|commence_?par|finit_?par|different|superieur|inferieur|entre)$/i;
const DIRECTION = /^(asc|desc|ascending|descending|croissant|decroissant)$/i;
/** Un code de l'application en capitales, sans chiffre (AND, CONTAINS, ACTIVE) : un jeton, pas une donnée. */
const UPPER_TOKEN = /^[A-Z][A-Z_]{1,40}$/;
/** Un nom de propriété porté en valeur (companyName, legal_name, address.city). */
const PROPERTY_REF =
  /^[a-z][a-zA-Z0-9]*([A-Z][a-zA-Z0-9]*)+$|^[a-z][a-z0-9]*(_[a-z0-9]+)+$|^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/;
const SENSITIVE_KEY =
  /(token|secret|password|pass|pwd|session|auth|otp|cookie|signature|(api|private|access|public|signing|encryption|crypto|client|master)[-_]?key$)/i;
/** Des fragments de noms qui suggèrent une pagination (indices seulement, jamais une règle). */
const PAGE_HINT = /(page|size|limit|offset|skip|take|lot|taille|per|count|nombre|numero|index|start|max)/i;
const SIZE_HINT = /(size|limit|count|per|take|max|taille|nombre)/i;
const PAGE_SIZES = new Set([5, 10, 12, 15, 20, 24, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250, 500, 1000]);

const MAX_LEAVES = 200;
const MAX_DEPTH = 8;

/** Plie une valeur pour comparer UI et API (casse, espaces, accents) : jamais gardée. */
export function foldValue(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Une valeur réduite à ce qui peut être gardé (voir l'en-tête). */
export function structuredValue(
  value: unknown,
  salt: string | undefined,
  sensitiveKey = false,
): StructuredValue {
  if (value === null || value === undefined) return { type: 'null', clear: null };
  if (sensitiveKey) return { type: typeof value === 'number' ? 'number' : 'string', masked: 'SENSITIVE_KEY' };
  if (typeof value === 'boolean') return { type: 'boolean', clear: value };
  if (typeof value === 'number') {
    const small = Number.isInteger(value) && Math.abs(value) < 10_000;
    return small
      ? { type: 'number', clear: value }
      : { type: 'number', masked: 'VALUE', ...digests(String(value), salt) };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // Un jeton de structure reste lisible, avec ses empreintes : s'il s'avère être une SAISIE de
  // l'humain (un nom en capitales), l'analyse le re-masque (masked: USER_INPUT).
  if (isStructureToken(text)) return { type: 'string', clear: text, ...digests(text, salt) };
  return { type: 'string', masked: 'VALUE', length: text.length, ...digests(text, salt) };
}

/** Un jeton de structure (opérateur, direction, code, nom de propriété) : gardé en clair. */
export function isStructureToken(text: string): boolean {
  return (
    LOGICAL.test(text) ||
    OPERATOR.test(text) ||
    DIRECTION.test(text) ||
    UPPER_TOKEN.test(text) ||
    PROPERTY_REF.test(text)
  );
}

function digests(text: string, salt: string | undefined): Pick<StructuredValue, 'digest' | 'folded'> {
  if (salt === undefined || text.trim() === '' || text.length > 500) return {};
  return { digest: valueDigest(text, salt), folded: valueDigest(foldValue(text), salt) };
}

/** Analyse une requête : paramètres d'URL et corps JSON (déjà décodé), sans rien garder d'autre. */
export function analyzeHttpRequest(input: {
  url: string;
  body?: unknown;
  contentType?: string;
  salt?: string;
}): HttpStructure {
  const structure: HttpStructure = {
    ...(input.contentType
      ? { contentType: input.contentType.split(';')[0]?.trim() ?? input.contentType }
      : {}),
    leaves: [],
    criteria: [],
    groups: [],
    sort: [],
    options: [],
    context: [],
    truncated: false,
  };
  const leaf = (
    path: string,
    source: StructureLeaf['source'],
    value: StructuredValue,
  ): StructureLeaf | undefined => {
    if (structure.leaves.length >= MAX_LEAVES) {
      structure.truncated = true;
      return undefined;
    }
    const entry = { path, source, value };
    structure.leaves.push(entry);
    return entry;
  };
  const claimed = new Set<string>();

  // ------------------------------------------------------------ paramètres d'URL
  let query: URLSearchParams | undefined;
  try {
    query = new URL(input.url, 'http://local.invalid').searchParams;
  } catch {
    query = undefined;
  }
  for (const [key, raw] of query ?? []) {
    const sensitive = SENSITIVE_KEY.test(key);
    const numeric = /^-?\d+$/.test(raw) ? Number(raw) : undefined;
    const typed: unknown = raw === 'true' ? true : raw === 'false' ? false : (numeric ?? raw);
    leaf(`?${key}`, 'QUERY', structuredValue(typed, input.salt, sensitive));
  }

  // ------------------------------------------------------------ corps JSON (récursif)
  const visit = (value: unknown, path: string, depth: number, group?: string): void => {
    if (depth > MAX_DEPTH) {
      structure.truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 50).forEach((entry, index) => {
        visit(entry, `${path}[${String(index)}]`, depth + 1, group);
      });
      if (value.length > 50) structure.truncated = true;
      return;
    }
    if (value === null || typeof value !== 'object') {
      const key =
        path
          .split('.')
          .at(-1)
          ?.replace(/\[\d+\]$/, '') ?? path;
      leaf(path, 'BODY', structuredValue(value, input.salt, SENSITIVE_KEY.test(key)));
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 80);
    const at = (key: string): string => (path ? `${path}.${key}` : key);
    const scalars = entries.filter(([, field]) => field === null || typeof field !== 'object');
    const text = (field: unknown): string | undefined => (typeof field === 'string' ? field : undefined);

    // Un GROUPE LOGIQUE : un opérateur logique à côté d'un tableau d'objets.
    const logical = scalars.find(([, field]) => text(field) !== undefined && LOGICAL.test(text(field) ?? ''));
    const childList = entries.find(
      ([, field]) => Array.isArray(field) && field.some((entry) => entry && typeof entry === 'object'),
    );
    let groupPath = group;
    if (logical && childList) {
      groupPath = path || '(root)';
      structure.groups.push({
        path: groupPath,
        operator: String(logical[1]).toUpperCase(),
        childrenPath: at(childList[0]),
        children: (childList[1] as unknown[]).length,
        ...(group ? { parent: group } : {}),
      });
      claimed.add(at(logical[0]));
    }

    // Un CRITÈRE : une propriété (un nom porté en valeur), un opérateur, une valeur comparée.
    const property = scalars.find(
      ([, field]) =>
        text(field) !== undefined &&
        PROPERTY_REF.test(text(field) ?? '') &&
        !OPERATOR.test(text(field) ?? '') &&
        !LOGICAL.test(text(field) ?? ''),
    );
    // Un opérateur du vocabulaire d'abord ; sinon un code en capitales (la valeur comparée peut en être un).
    const operator =
      scalars.find(([key, field]) => key !== property?.[0] && OPERATOR.test(text(field) ?? '')) ??
      scalars.find(
        ([key, field]) =>
          key !== property?.[0] &&
          UPPER_TOKEN.test(text(field) ?? '') &&
          !LOGICAL.test(text(field) ?? '') &&
          !DIRECTION.test(text(field) ?? ''),
      );
    const direction = scalars.find(
      ([, field]) => text(field) !== undefined && DIRECTION.test(text(field) ?? ''),
    );
    if (property && direction && !operator) {
      structure.sort.push({
        path: path || '(root)',
        property: String(property[1]),
        direction: String(direction[1]),
      });
      claimed.add(at(property[0]));
      claimed.add(at(direction[0]));
    } else if (property && (operator || group !== undefined)) {
      const compared = entries.find(
        ([key]) => key !== property[0] && key !== operator?.[0] && !(logical && key === logical[0]),
      );
      if (compared) {
        const valuePath = at(compared[0]);
        const first = Array.isArray(compared[1]) ? (compared[1] as unknown[])[0] : compared[1];
        structure.criteria.push({
          path: path || '(root)',
          source: 'BODY',
          property: String(property[1]),
          propertyFrom: 'VALUE',
          ...(operator ? { operator: String(operator[1]) } : {}),
          valuePath,
          value: structuredValue(
            first !== null && typeof first === 'object' ? JSON.stringify(first) : first,
            input.salt,
            SENSITIVE_KEY.test(compared[0]),
          ),
          ...(groupPath ? { group: groupPath } : {}),
          form: 'STRUCTURE',
          confidence: operator ? 0.85 : 0.65,
        });
        claimed.add(at(property[0]));
        if (operator) claimed.add(at(operator[0]));
        claimed.add(valuePath);
      }
    }
    for (const [key, field] of entries) visit(field, at(key), depth + 1, groupPath);
  };
  if (input.body !== undefined) visit(input.body, '', 0);

  // ------------------------------------------------------------ pagination (deux petits entiers, indices de noms)
  const numbers = structure.leaves.filter(
    (entry) => typeof entry.value.clear === 'number' && !entry.path.includes('['),
  );
  // Deux tailles possibles (40 et 20) : la taille est celle que son nom désigne, sinon la plus petite.
  const sizes = numbers.filter((entry) => PAGE_SIZES.has(entry.value.clear as number));
  const size =
    sizes.find((entry) => SIZE_HINT.test(entry.path)) ??
    [...sizes].sort((a, b) => (a.value.clear as number) - (b.value.clear as number))[0];
  const index = numbers.find(
    (entry) =>
      entry !== size &&
      (entry.value.clear as number) >= 0 &&
      (entry.value.clear as number) <= 10_000 &&
      parentOf(entry.path) === parentOf(size?.path ?? entry.path),
  );
  if (size || index) {
    const evidence: string[] = [];
    let confidence = 0.3;
    if (size) {
      confidence += 0.2;
      evidence.push(`${size.path} = ${String(size.value.clear)} (a usual page size)`);
    }
    if (size && index) {
      confidence += 0.2;
      evidence.push(`${index.path} = ${String(index.value.clear)} next to it (a page index or offset)`);
    }
    const hinted = [size, index].filter((entry) => entry && PAGE_HINT.test(entry.path));
    if (hinted.length) {
      confidence += 0.2;
      evidence.push(`name hints: ${hinted.map((entry) => entry?.path ?? '').join(', ')}`);
    }
    if (confidence >= 0.5) {
      structure.pagination = {
        ...(index ? { index: { path: index.path, value: index.value.clear as number } } : {}),
        ...(size ? { size: { path: size.path, value: size.value.clear as number } } : {}),
        confidence: Math.min(0.95, Math.round(confidence * 100) / 100),
        evidence,
      };
      if (size) claimed.add(size.path);
      if (index) claimed.add(index.path);
    }
  }

  // ------------------------------------------------------------ le reste : options, critères implicites, contexte
  for (const entry of structure.leaves) {
    if (claimed.has(entry.path)) continue;
    if (entry.value.type === 'boolean') structure.options.push(entry);
    else if (entry.value.masked === 'VALUE' && entry.value.type === 'string') {
      // Une valeur saisissable posée sous une clé : un critère CANDIDAT (la propriété est la clé) — à
      // confirmer par une saisie de l'humain ; sinon un paramètre de contexte.
      const key =
        entry.path
          .split('.')
          .at(-1)
          ?.replace(/^\?/, '')
          .replace(/\[\d+\]$/, '') ?? entry.path;
      structure.criteria.push({
        path: entry.path,
        source: entry.source,
        property: key,
        propertyFrom: 'KEY',
        valuePath: entry.path,
        value: entry.value,
        form: 'IMPLICIT',
        confidence: 0.4,
      });
    } else structure.context.push(entry);
  }
  return structure;
}

function parentOf(path: string): string {
  if (path.startsWith('?')) return '?';
  const index = path.lastIndexOf('.');
  return index < 0 ? '' : path.slice(0, index);
}
