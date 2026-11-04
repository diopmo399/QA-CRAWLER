import type { TestDataEntry, TestDataSet } from '../../data/test-data-set.js';
import type {
  BlockContract,
  ContractField,
  ContractFields,
  DataType,
  FieldDeclaration,
  FieldDetection,
  FieldOrigin,
} from '../core/contracts.js';
import { DATA_TYPES } from '../core/contracts.js';

/**
 * LES DONNÉES D'UN BLOC, DÉCRITES : à partir de ses étapes (dans l'ordre), de son jeu de données, de son
 * contrat effectif et de ce qu'une personne en a déclaré. Une fonction pure.
 *
 *   entrée     lue par une référence explicite (`{ testData: clé }`, `${testData:clé}`) sans être définie
 *              par le bloc : CONFIRMÉE (l'étape le montre) ; déclarée sans lecture : INCONNUE.
 *   sortie     générée au rejeu (son générateur) ou capturée (sa source) : CONFIRMÉE ; valeur fixe du jeu
 *              saisie par une étape : PROBABLE (exposée, sans preuve qu'un bloc suivant en dépende).
 *   candidate  une valeur littérale saisie dans un champ : une entrée POSSIBLE (PROBABLE si le champ est
 *              nommé, INCONNUE sinon) ; jamais ajoutée au contrat sans une personne.
 * Le type vient d'une déclaration ; sinon d'un indice (générateur, nom, source), dit « proposé » ; sinon
 * `text`, le type de toute valeur du moteur. Rien n'est converti, rien n'est supposé confirmé.
 */

export interface StoredField {
  label?: string;
  description?: string;
  meaning?: string;
  type?: DataType;
  defaultValue?: string;
  confirmed?: boolean;
  /** La version de la définition (1 au départ ; une évolution incompatible l'incrémente). */
  version: number;
}

export type StoredFields = Record<string, StoredField>;

export const fieldKey = (direction: 'input' | 'output', key: string): string => `${direction}:${key}`;

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Un texte ou un nombre en mots ; autre chose : la valeur de repli. */
const str = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
const SENSITIVE = /pass(word)?|pwd|secret|token|otp|cookie|session|credential|api[-_]?key|private/i;

interface Use {
  step: number;
  how: 'fill' | 'cite' | 'capture' | 'copy';
  field?: string;
  source?: string;
  /** Une capture `generate` : le générateur de la valeur produite par l’étape. */
  generator?: string;
}

/** Le nom visible d'une cible brute (libellé, nom, texte, testId, css). */
function targetName(target: Raw): string | undefined {
  for (const key of ['label', 'name', 'text', 'testId'] as const)
    if (typeof target[key] === 'string' && target[key] !== '') return target[key];
  return undefined;
}

function captureSource(capture: Raw): string {
  if (isObject(capture.text)) return `texte de « ${targetName(capture.text) ?? str(capture.text.css, '?')} »`;
  if (isObject(capture.attribute))
    return `attribut ${str(capture.attribute.attribute, '?')} de « ${targetName(capture.attribute) ?? str(capture.attribute.css, '?')} »`;
  if (isObject(capture.url))
    return typeof capture.url.param === 'string'
      ? `paramètre ${capture.url.param} de l’adresse`
      : `adresse (motif ${str(capture.url.pattern, '')})`;
  if (isObject(capture.response))
    return `champ ${str(capture.response.field, '?')} de la réponse ${capture.response.method ? `${str(capture.response.method, '')} ` : ''}${str(capture.response.url, '?')}`;
  if (typeof capture.data === 'string') return `donnée ${capture.data} du run`;
  if (typeof capture.generate === 'string') return `valeur générée (générateur ${capture.generate})`;
  return 'source inconnue';
}

/** La source d'une capture, et sa transformation éventuelle (« …, en majuscules »). */
function captureDescription(capture: Raw): string {
  const transform =
    capture.transform === 'uppercase'
      ? 'en majuscules'
      : capture.transform === 'lowercase'
        ? 'en minuscules'
        : capture.transform === 'trim'
          ? 'espaces retirés'
          : capture.transform === 'digits'
            ? 'chiffres seulement'
            : undefined;
  return `${captureSource(capture)}${transform ? `, ${transform}` : ''}`;
}

/** Les usages de chaque clé, étape par étape (positions 1…n), et les valeurs littérales saisies. */
export function stepUses(steps: readonly unknown[]): {
  uses: Map<string, Use[]>;
  literals: { step: number; field?: string; sensitive: boolean }[];
} {
  const uses = new Map<string, Use[]>();
  const literals: { step: number; field?: string; sensitive: boolean }[] = [];
  const add = (key: string, use: Use): void => {
    uses.set(key, [...(uses.get(key) ?? []), use]);
  };
  steps.forEach((raw, index) => {
    const step = index + 1;
    if (!isObject(raw)) return;
    const visit = (node: unknown, field?: string): void => {
      if (typeof node === 'string') {
        for (const match of node.matchAll(/\$\{testData:([^}]+)\}/g))
          if (match[1]) add(match[1].trim(), { step, how: 'cite', ...(field ? { field } : {}) });
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item) => {
          visit(item, field);
        });
        return;
      }
      if (!isObject(node)) return;
      if (typeof node.testData === 'string' && Object.keys(node).length === 1) {
        add(node.testData, { step, how: 'fill', ...(field ? { field } : {}) });
        return;
      }
      for (const value of Object.values(node)) visit(value, field);
    };
    if (isObject(raw.capture)) {
      const capture = raw.capture;
      if (typeof capture.as === 'string')
        add(capture.as, {
          step,
          how: 'capture',
          source: captureDescription(capture),
          ...(typeof capture.generate === 'string' ? { generator: capture.generate } : {}),
        });
      if (typeof capture.data === 'string') add(capture.data, { step, how: 'copy' });
      visit({ ...capture, as: undefined, data: undefined });
      return;
    }
    if (isObject(raw.fill)) {
      const fill = raw.fill;
      const field = targetName(fill);
      if (typeof fill.value === 'string' || typeof fill.value === 'number') {
        if (!String(fill.value).includes('${testData:'))
          literals.push({
            step,
            ...(field ? { field } : {}),
            sensitive: SENSITIVE.test(field ?? '') || SENSITIVE.test(str(fill.css, '')),
          });
        else visit(fill.value, field);
      } else visit(fill.value, field);
      visit({ ...fill, value: undefined });
      return;
    }
    visit(raw);
  });
  return { uses, literals };
}

/** Un type proposé d'après un indice (jamais déclaré) ; undefined : aucun indice. */
export function inferType(
  key: string,
  hints: { generator?: string; field?: string; source?: string },
): DataType | undefined {
  const words = `${hints.generator ?? ''} ${hints.field ?? ''} ${key}`.toLowerCase();
  if (/e-?mail|courriel/.test(words)) return 'email';
  if (/\bdate\b|birth|naissance|deadline|échéance/.test(words)) return 'date';
  if (/\b(url|link|lien|href)\b/.test(words) || hints.source?.startsWith('attribut href')) return 'url';
  if (
    /(^|[._-])(id|uuid|ref|reference|number|num|code)$/.test(key.toLowerCase()) ||
    hints.generator === 'unique'
  )
    return 'identifier';
  if (/\b(amount|montant|price|prix|quantity|quantité|count|total)\b/.test(words)) return 'number';
  return undefined;
}

function typed(
  key: string,
  stored: StoredField | undefined,
  hints: { generator?: string; field?: string; source?: string },
): Pick<ContractField, 'type' | 'typeSource'> {
  if (stored?.type) return { type: stored.type, typeSource: 'DECLARED' };
  const inferred = inferType(key, hints);
  return inferred ? { type: inferred, typeSource: 'INFERRED' } : { type: 'text', typeSource: 'DEFAULT' };
}

function originOf(entry: TestDataEntry | undefined, captured: boolean, generatedByStep = false): FieldOrigin {
  if (generatedByStep) return 'GENERATED';
  if (captured) return 'CAPTURED';
  if (entry?.strategy === 'GENERATE_AT_REPLAY' || entry?.strategy === 'TEMPLATE') return 'GENERATED';
  return 'DATA';
}

const stepsText = (steps: readonly number[]): string =>
  steps.length === 1 ? `l’étape ${String(steps[0])}` : `les étapes ${steps.join(', ')}`;

const slugKey = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'value';

/** LES DONNÉES DU CONTRAT, décrites (voir l'en-tête). */
export function contractFields(input: {
  blockId: string;
  steps: readonly unknown[];
  data?: TestDataSet;
  contract: BlockContract;
  stored?: StoredFields;
}): ContractFields {
  const { uses, literals } = stepUses(input.steps);
  const own = input.data?.values ?? {};
  const stored = input.stored ?? {};
  const meta = (stored: StoredField | undefined): Partial<ContractField> => ({
    ...(stored?.label ? { label: stored.label } : {}),
    ...(stored?.description ? { description: stored.description } : {}),
    ...(stored?.meaning ? { meaning: stored.meaning } : {}),
  });
  const inputs = input.contract.inputs.map((entry): ContractField => {
    const known = stored[fieldKey('input', entry.key)];
    const reads = (uses.get(entry.key) ?? []).filter((use) => use.how !== 'capture');
    const referencing = Object.values(own).filter(
      (value) => value.strategy === 'REFERENCE' && value.reference === entry.key,
    );
    const steps = [...new Set(reads.map((use) => use.step))];
    const evidence: string[] = [];
    if (steps.length > 0)
      evidence.push(
        `lue par une référence explicite à ${stepsText(steps)} (${[...new Set(reads.map((use) => (use.how === 'fill' ? 'saisie' : use.how === 'copy' ? 'recopiée' : 'citée')))].join(', ')})`,
      );
    for (const value of referencing) evidence.push(`la donnée ${value.key} du jeu y fait référence`);
    let detection: FieldDetection = evidence.length > 0 ? 'CONFIRMED' : 'UNKNOWN';
    if (evidence.length === 0) evidence.push('déclarée dans le contrat, mais aucune étape ne la lit');
    if (known?.confirmed === true) {
      detection = 'CONFIRMED';
      evidence.push('confirmée par une personne');
    }
    const field = reads.find((use) => use.field)?.field;
    return {
      id: `${input.blockId}:input:${entry.key}`,
      direction: 'input',
      key: entry.key,
      ...meta(known),
      ...typed(entry.key, known, { ...(field ? { field } : {}) }),
      required: entry.required,
      origin: 'INPUT',
      version: known?.version ?? 1,
      detection,
      evidence,
      steps,
      ...(known?.defaultValue !== undefined && !SENSITIVE.test(entry.key)
        ? { defaultValue: known.defaultValue }
        : {}),
      exposed: true,
    };
  });
  const outputKeys = new Set(input.contract.outputs.map((entry) => entry.key));
  const hiddenOutputs = Object.entries(stored)
    .filter(([id, value]) => id.startsWith('output:') && value.confirmed === false)
    .map(([id]) => id.slice('output:'.length));
  const declaredOutputs = input.contract.source === 'DECLARED';
  const outputs = [...outputKeys, ...hiddenOutputs.filter((key) => !outputKeys.has(key))].map(
    (key): ContractField => {
      const known = stored[fieldKey('output', key)];
      const entry = own[key];
      const keyUses = uses.get(key) ?? [];
      const capture = keyUses.find((use) => use.how === 'capture');
      const producing = keyUses.filter((use) => use.how === (capture ? 'capture' : 'fill'));
      const steps = [...new Set(producing.map((use) => use.step))];
      const origin = originOf(entry, capture !== undefined, capture?.generator !== undefined);
      const evidence: string[] = [];
      let detection: FieldDetection;
      if (origin === 'CAPTURED') {
        evidence.push(`capturée à ${stepsText(steps)} depuis ${capture?.source ?? '?'}`);
        detection = 'CONFIRMED';
      } else if (origin === 'GENERATED' && capture?.generator !== undefined) {
        evidence.push(
          `générée au rejeu par l’étape ${stepsText(steps).replace(/^l’étape /, '')} (générateur ${capture.generator}), une fois par exécution`,
        );
        detection = 'CONFIRMED';
      } else if (origin === 'GENERATED') {
        evidence.push(
          `générée au rejeu (${entry?.strategy === 'TEMPLATE' ? 'modèle' : `générateur ${entry?.generator ?? entry?.semanticType ?? 'par défaut'}`}), une fois par exécution${steps.length > 0 ? `, saisie à ${stepsText(steps)}` : ''}`,
        );
        detection = 'CONFIRMED';
      } else {
        evidence.push(
          `valeur ${entry && entry.strategy !== 'RECORDED_LITERAL' && entry.strategy !== 'BUSINESS_LITERAL' ? `(${entry.strategy})` : 'fixe'} du jeu du bloc${steps.length > 0 ? `, saisie à ${stepsText(steps)}` : ''} : exposée, sans preuve qu’un bloc suivant en dépende`,
        );
        detection = 'PROBABLE';
      }
      if (declaredOutputs) {
        evidence.push('déclarée dans le contrat');
        if (detection === 'PROBABLE') detection = 'CONFIRMED';
      }
      if (known?.confirmed === true) {
        evidence.push('confirmée par une personne');
        detection = 'CONFIRMED';
      }
      const exposed = known?.confirmed !== false;
      if (!exposed) evidence.push('non exposée : une personne l’a retirée des sorties');
      const field = producing.find((use) => use.field)?.field;
      return {
        id: `${input.blockId}:output:${key}`,
        direction: 'output',
        key,
        ...meta(known),
        ...typed(key, known, {
          ...(capture?.generator
            ? { generator: capture.generator }
            : entry?.generator
              ? { generator: entry.generator }
              : entry?.semanticType
                ? { generator: entry.semanticType }
                : {}),
          ...(field ? { field } : {}),
          ...(capture?.source ? { source: capture.source } : {}),
        }),
        required: false,
        origin,
        version: known?.version ?? 1,
        detection,
        evidence,
        steps,
        exposed,
        ...((capture?.generator ?? entry?.generator)
          ? { generator: capture?.generator ?? entry?.generator }
          : {}),
        ...(capture?.source && capture.generator === undefined
          ? { capture: { source: capture.source, onFailure: 'FAIL' as const } }
          : {}),
      };
    },
  );
  const taken = new Set([...inputs, ...outputs].map((field) => field.key));
  const candidates = literals
    .filter((literal) => !literal.sensitive)
    .map((literal): ContractField => {
      const base = `input.${slugKey(literal.field ?? `step_${String(literal.step)}`)}`;
      let key = base;
      for (let index = 2; taken.has(key); index += 1) key = `${base}_${String(index)}`;
      taken.add(key);
      return {
        id: `${input.blockId}:candidate:${String(literal.step)}`,
        direction: 'candidate',
        key,
        ...(literal.field ? { label: literal.field } : {}),
        ...typed(key, undefined, { ...(literal.field ? { field: literal.field } : {}) }),
        required: true,
        origin: 'LITERAL',
        version: 1,
        detection: literal.field ? 'PROBABLE' : 'UNKNOWN',
        evidence: [
          literal.field
            ? `une valeur fixe est saisie dans « ${literal.field} » à l’étape ${String(literal.step)} : une entrée possible, à confirmer`
            : `une valeur fixe est saisie à l’étape ${String(literal.step)} dans un champ sans nom : son rôle n’est pas établi`,
        ],
        steps: [literal.step],
        exposed: false,
      };
    });
  return { inputs, outputs, candidates };
}

/** Une déclaration reçue (JSON) ramenée à sa forme ; undefined : rien d'utilisable. */
export function sanitizeDeclaration(raw: unknown): FieldDeclaration | undefined {
  if (!isObject(raw)) return undefined;
  const direction = raw.direction === 'input' || raw.direction === 'output' ? raw.direction : undefined;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!direction || !/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(key)) return undefined;
  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const clean = value.replace(/\s+/g, ' ').trim().slice(0, max);
    return clean || undefined;
  };
  const type = DATA_TYPES.find((candidate) => candidate === raw.type);
  const label = text(raw.label, 80);
  const description = text(raw.description, 300);
  const meaning = text(raw.meaning, 120);
  const defaultValue =
    direction === 'input' && !SENSITIVE.test(key) ? text(raw.defaultValue, 300) : undefined;
  return {
    direction,
    key,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(meaning ? { meaning } : {}),
    ...(type ? { type } : {}),
    ...(defaultValue ? { defaultValue } : {}),
    ...(typeof raw.confirmed === 'boolean' ? { confirmed: raw.confirmed } : {}),
  };
}

/**
 * Une évolution INCOMPATIBLE de la définition d'une donnée : un type ou un sens métier déclarés qui
 * changent, une sortie retirée, une entrée qui devient obligatoire. Undefined : compatible.
 */
export function incompatibility(
  before: StoredField | undefined,
  after: StoredField,
  direction: 'input' | 'output',
): string | undefined {
  if (before?.type && after.type && before.type !== after.type) return `type ${before.type} → ${after.type}`;
  if (before?.meaning && after.meaning && before.meaning !== after.meaning)
    return `sens « ${before.meaning} » → « ${after.meaning} »`;
  if (direction === 'output' && before?.confirmed !== false && after.confirmed === false)
    return 'sortie retirée';
  return undefined;
}
