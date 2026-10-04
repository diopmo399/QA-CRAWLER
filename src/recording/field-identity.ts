import type { RawRecordedEvent, RecordedElement, RecordedValueFacts } from './model.js';
import { semanticIdOf } from './recorded-target.js';

/**
 * FIELD IDENTITY : « est-ce fonctionnellement le MÊME champ ? » — à ne pas confondre avec
 * l'empreinte de cible (« quel élément retrouver au rejeu ? »). Les deux partagent les mêmes
 * primitives (la description capturée de l'élément) ; aucune n'est un CSS.
 *
 * SAME CSS ≠ SAME FIELD. SAME ID STRING ≠ SAME FIELD IF THE DOM CONTAINS DUPLICATES.
 * TEMPORAL PROXIMITY ≠ FIELD IDENTITY. PRESERVE FIRST, MERGE ONLY WITH STRONG EVIDENCE.
 */
export type ValueProfileType =
  'TEXT' | 'NUMERIC' | 'EMAIL' | 'DATE' | 'BOOLEAN' | 'ENUM' | 'IDENTIFIER' | 'UNKNOWN';

/** Le profil d'une saisie : un signal de plus, jamais l'identité principale. */
export interface ValueProfile {
  type: ValueProfileType;
  length?: number;
  maxLength?: number;
  inputMode?: string;
  pattern?: string;
}

export type LocatorUniqueness = 'UNIQUE' | 'NON_UNIQUE' | 'UNKNOWN';

export interface FieldIdentity {
  /** L'instance DOM vue par l'enregistreur (e42) : une preuve d'enregistrement, jamais un localisateur. */
  domInstance?: string;
  elementId?: string;
  /** L'id n'est porté que par cet élément (un #valueInput dupliqué ne l'est pas). */
  idUnique: boolean;
  name?: string;
  formControlName?: string;
  accessibleName?: string;
  label?: string;
  /** Le libellé du champ fonctionnel qui l'entoure (mat-label, legend…), relié ou non. */
  formField?: string;
  placeholder?: string;
  testId?: string;
  inputType?: string;
  tagName: string;
  role?: string;
  dialogContext?: string;
  sectionContext?: string;
  componentIdentity?: string;
  nearbyText?: string[];
  semanticConcept?: string;
  /** Le CSS enregistré : un repli, jamais une identité à lui seul. */
  domPathFingerprint: string;
  locatorUniqueness: LocatorUniqueness;
  valueProfile: ValueProfile;
}

export type FieldIdentityVerdict =
  'EXACT_SAME_FIELD' | 'STRONG_SAME_FIELD' | 'AMBIGUOUS_FIELD' | 'DIFFERENT_FIELD';

export interface FieldIdentityConfidence {
  score: number;
  reasons: string[];
}

export interface FieldIdentityMatch {
  verdict: FieldIdentityVerdict;
  confidence: FieldIdentityConfidence;
}

const readable = (text: string | undefined): text is string =>
  text !== undefined && text.trim() !== '' && !/^(input|field|text|textbox)$/i.test(text.trim());

const norm = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s*:]+/g, ' ')
    .trim();

/** Le profil de saisie : le type de l'élément d'abord, la forme de la valeur ensuite. */
export function valueProfileOf(element: RecordedElement, facts?: RecordedValueFacts): ValueProfile {
  const type: ValueProfileType =
    element.inputType === 'checkbox' || element.inputType === 'radio'
      ? 'BOOLEAN'
      : element.tag === 'select' || element.customSelect || element.hasOptions
        ? 'ENUM'
        : element.inputType === 'number' || element.inputMode === 'numeric' || element.inputMode === 'decimal'
          ? 'NUMERIC'
          : element.inputType === 'email'
            ? 'EMAIL'
            : element.inputType === 'date'
              ? 'DATE'
              : facts?.shape === 'number'
                ? 'NUMERIC'
                : facts?.shape === 'email'
                  ? 'EMAIL'
                  : facts?.shape === 'date'
                    ? 'DATE'
                    : facts?.shape === 'code'
                      ? 'IDENTIFIER'
                      : facts?.shape === 'text' || facts?.shape === 'phone' || facts?.shape === 'url'
                        ? 'TEXT'
                        : 'UNKNOWN';
  return {
    type,
    ...(facts && !facts.empty ? { length: facts.length } : {}),
    ...(element.maxLength !== undefined ? { maxLength: element.maxLength } : {}),
    ...(element.inputMode ? { inputMode: element.inputMode } : {}),
    ...(element.pattern ? { pattern: element.pattern } : {}),
  };
}

/** L'identité d'un champ, construite de la description capturée (la même que l'empreinte de cible). */
export function buildFieldIdentity(
  element: RecordedElement,
  facts?: RecordedValueFacts,
  /** Le nombre d'éléments que le CSS désignait à la capture (pre.cssCount). */
  cssCount?: number,
): FieldIdentity {
  const section =
    element.sectionPath && element.sectionPath.length > 0 ? element.sectionPath.join(' > ') : undefined;
  const label = readable(element.label) ? element.label : undefined;
  const matches = element.cssMatches ?? cssCount;
  const locatorUniqueness: LocatorUniqueness =
    matches !== undefined && matches > 1
      ? 'NON_UNIQUE'
      : element.cssStable || matches === 1
        ? 'UNIQUE'
        : 'UNKNOWN';
  const semantic = semanticIdOf(section, label ?? element.formField ?? element.guessedLabel);
  return {
    ...(element.domInstance ? { domInstance: element.domInstance } : {}),
    ...(element.elementId && !element.generatedId ? { elementId: element.elementId } : {}),
    idUnique: element.elementId !== undefined && !element.generatedId && (element.sameId ?? 1) <= 1,
    ...(element.nameAttr && !/\d{2,}/.test(element.nameAttr) ? { name: element.nameAttr } : {}),
    ...(element.formControlName ? { formControlName: element.formControlName } : {}),
    ...(readable(element.name) ? { accessibleName: element.name } : {}),
    ...(label ? { label } : {}),
    ...(readable(element.formField) ? { formField: element.formField } : {}),
    ...(readable(element.placeholder) ? { placeholder: element.placeholder } : {}),
    ...(element.testId ? { testId: element.testId } : {}),
    ...(element.inputType ? { inputType: element.inputType } : {}),
    tagName: element.tag,
    ...(element.role ? { role: element.role } : {}),
    ...(element.inDialog && element.dialogName ? { dialogContext: element.dialogName } : {}),
    ...(section ? { sectionContext: section } : {}),
    ...(element.componentTag ? { componentIdentity: element.componentTag } : {}),
    ...(element.nearbyText && element.nearbyText.length > 0 ? { nearbyText: element.nearbyText } : {}),
    ...(semantic ? { semanticConcept: semantic } : {}),
    domPathFingerprint: element.css,
    locatorUniqueness,
    valueProfile: valueProfileOf(element, facts),
  };
}

/** L'identité d'un événement brut (son élément, sa valeur, l'unicité de son CSS à la capture). */
export function fieldIdentityOfEvent(event: RawRecordedEvent | undefined): FieldIdentity | undefined {
  if (!event?.element) return undefined;
  return buildFieldIdentity(event.element, event.value, event.pre?.cssCount);
}

/**
 * FIELD KEY V2 : la clé fonctionnelle d'un champ, dans son contexte (dialogue, section).
 * formControlName → test id → name → id stable UNIQUE → libellé → libellé du champ (mat-label) →
 * placeholder → CSS démontré unique → instance DOM. undefined : aucune identité démontrée (la
 * saisie reste seule, jamais confondue avec une autre).
 */
export function fieldIdentityKey(identity: FieldIdentity): string | undefined {
  const context = [identity.dialogContext, identity.sectionContext].filter(Boolean).join(' > ');
  if (identity.formControlName) return `formControl:${context}:${identity.formControlName}`;
  if (identity.testId) return `testid:${context}:${identity.testId}`;
  if (identity.name) return `name:${context}:${identity.name}`;
  if (identity.elementId && identity.idUnique) return `id:${context}:${identity.elementId}`;
  if (identity.label) return `label:${context}:${norm(identity.label)}`;
  if (identity.formField) return `field:${context}:${norm(identity.formField)}`;
  if (identity.placeholder) return `placeholder:${context}:${norm(identity.placeholder)}`;
  if (identity.locatorUniqueness === 'UNIQUE') return `css:${identity.domPathFingerprint}`;
  if (identity.domInstance) return `dom:${identity.domInstance}`;
  return undefined;
}

/** Une empreinte courte et stable d'une identité (clé de données de test de repli : field_<empreinte>). */
export function fieldIdentityDigest(identity: FieldIdentity): string {
  const source = fieldIdentityKey(identity) ?? `${identity.domPathFingerprint}|${identity.domInstance ?? ''}`;
  let hash = 2166136261;
  for (const char of source) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

/**
 * FIELD IDENTITY MATCHER : deux observations désignent-elles le même champ fonctionnel ?
 * Une contradiction (autre libellé, contexte, type, profil) suffit à les séparer ; un CSS
 * générique seul ne prouve rien (AMBIGUOUS_FIELD au mieux) ; deux instances DOM différentes ne
 * sont le même champ (re-rendu) qu'avec un identifiant fonctionnel commun.
 */
export function matchFieldIdentity(a: FieldIdentity, b: FieldIdentity): FieldIdentityMatch {
  const support: string[] = [];
  const contradictions: string[] = [];
  const strong: string[] = [];
  const semantic: string[] = [];
  const compare = (
    left: string | undefined,
    right: string | undefined,
    what: string,
    kind?: 'strong' | 'semantic',
  ): void => {
    if (left === undefined || right === undefined) return;
    if (norm(left) === norm(right)) {
      support.push(`same ${what}`);
      if (kind === 'strong') strong.push(what);
      if (kind === 'semantic') semantic.push(what);
    } else contradictions.push(`different ${what} ("${left}" ≠ "${right}")`);
  };
  compare(a.formControlName, b.formControlName, 'formControlName', 'strong');
  compare(a.testId, b.testId, 'test id', 'strong');
  compare(a.name, b.name, 'name attribute', 'strong');
  if (a.idUnique && b.idUnique) compare(a.elementId, b.elementId, 'stable id', 'strong');
  compare(a.label, b.label, 'label', 'semantic');
  compare(a.formField, b.formField, 'field label', 'semantic');
  compare(a.placeholder, b.placeholder, 'placeholder', 'semantic');
  compare(a.dialogContext, b.dialogContext, 'dialog');
  compare(a.sectionContext, b.sectionContext, 'section');
  compare(a.tagName, b.tagName, 'tag');
  compare(a.inputType, b.inputType, 'input type');
  // Le profil de saisie : les attributs de l'élément (un même élément les garde) ; la forme de
  // la valeur seulement entre deux nœuds différents (une frappe en cours change de forme).
  const bothCaptured = a.domInstance !== undefined && b.domInstance !== undefined;
  const pa = a.valueProfile;
  const pb = b.valueProfile;
  if (
    (bothCaptured || (pa.maxLength !== undefined && pb.maxLength !== undefined)) &&
    pa.maxLength !== pb.maxLength
  )
    contradictions.push(
      `incompatible value profile (maxlength ${String(pa.maxLength ?? 'none')} ≠ ${String(pb.maxLength ?? 'none')})`,
    );
  if ((bothCaptured || (pa.inputMode && pb.inputMode)) && (pa.inputMode ?? '') !== (pb.inputMode ?? ''))
    contradictions.push(
      `incompatible value profile (inputmode ${pa.inputMode ?? 'none'} ≠ ${pb.inputMode ?? 'none'})`,
    );
  const sameInstance = bothCaptured && a.domInstance === b.domInstance;
  if (
    !sameInstance &&
    pa.type !== pb.type &&
    pa.type !== 'UNKNOWN' &&
    pb.type !== 'UNKNOWN' &&
    [pa.type, pb.type].includes('NUMERIC')
  )
    contradictions.push(`incompatible value profile (${pa.type} ≠ ${pb.type})`);
  const sameCss = a.domPathFingerprint === b.domPathFingerprint;
  const generic = a.locatorUniqueness === 'NON_UNIQUE' || b.locatorUniqueness === 'NON_UNIQUE';
  const cssNote = sameCss
    ? generic
      ? 'same CSS, but the locator is not unique (generic)'
      : 'same CSS'
    : 'different CSS';
  if (bothCaptured) support.push(sameInstance ? 'same DOM instance' : '');
  const reasons = (extra: string[]): string[] => [...extra, ...support.filter(Boolean), cssNote];

  if (contradictions.length > 0)
    return {
      verdict: 'DIFFERENT_FIELD',
      confidence: {
        score: Math.max(0.05, 0.35 - 0.08 * contradictions.length),
        reasons: [
          ...contradictions,
          ...(bothCaptured && !sameInstance ? ['different DOM instance'] : []),
          ...reasons([]),
        ],
      },
    };
  if (sameInstance) return { verdict: 'EXACT_SAME_FIELD', confidence: { score: 0.97, reasons: reasons([]) } };
  if (bothCaptured) {
    // Deux nœuds différents : le même champ re-rendu seulement avec un identifiant fonctionnel commun.
    if (strong.length > 0 && (semantic.length > 0 || (!a.label && !a.formField && !a.placeholder)))
      return {
        verdict: 'STRONG_SAME_FIELD',
        confidence: {
          score: 0.85,
          reasons: reasons([
            'different DOM instance, same functional identifiers: the field was re-rendered',
          ]),
        },
      };
    if (semantic.length > 0)
      return {
        verdict: 'AMBIGUOUS_FIELD',
        confidence: {
          score: 0.45,
          reasons: reasons(['different DOM instance: the same label alone does not prove a re-render']),
        },
      };
    return {
      verdict: 'DIFFERENT_FIELD',
      confidence: {
        score: 0.25,
        reasons: reasons([
          'different DOM instance',
          sameCss ? 'same generic CSS only' : 'no common identifier',
        ]),
      },
    };
  }
  // Un ancien enregistrement (sans instance DOM).
  if (strong.length > 0 || semantic.length > 0)
    return {
      verdict: sameCss && !generic ? 'EXACT_SAME_FIELD' : 'STRONG_SAME_FIELD',
      confidence: { score: sameCss && !generic ? 0.93 : 0.85, reasons: reasons([]) },
    };
  if (sameCss && a.locatorUniqueness === 'UNIQUE' && b.locatorUniqueness === 'UNIQUE')
    return {
      verdict: 'STRONG_SAME_FIELD',
      confidence: { score: 0.8, reasons: reasons(['locator proven unique']) },
    };
  return {
    verdict: 'AMBIGUOUS_FIELD',
    confidence: {
      score: sameCss ? 0.4 : 0.2,
      reasons: reasons([
        sameCss ? 'only the same CSS: no label, id or DOM instance' : 'no common identifier',
      ]),
    },
  };
}

/** Seules ces deux conclusions autorisent une fusion. */
export function sameFunctionalField(match: FieldIdentityMatch): boolean {
  return match.verdict === 'EXACT_SAME_FIELD' || match.verdict === 'STRONG_SAME_FIELD';
}
