import type { FlowExpectation, FlowStep } from '../config/flow-schema.js';
import type { AssertionConfig, ValueRef } from '../config/quality-schema.js';

/**
 * LA TRADUCTION COMMUNE DES ASSERTIONS MÉTIER (schéma de la mission, `assertions:`) vers les tests
 * générés. Une seule règle, partagée par Playwright TypeScript, Gherkin et Java :
 *
 *   NATIVE        ce qu'un test autonome peut vérifier sur l'écran (une valeur, une entité ou un état
 *                 affiché) devient une attente `expect` du flow, que chaque générateur sait déjà écrire ;
 *   REPLAY_ONLY   ce qui exige le réseau observé, une API relue ou le contrat OpenAPI n'est vérifié que
 *                 par le rejeu QA-CRAWLER (BusinessAssertionEngine) : le test généré le dit en
 *                 commentaire, jamais en silence, jamais comme un succès.
 *
 * Les générateurs traduisent ce modèle ; ils ne réinventent aucune règle d'assertion.
 */
export type AssertionSupport = 'NATIVE' | 'REPLAY_ONLY';

export interface TranslatedAssertion {
  id: string;
  description: string;
  mandatory: boolean;
  criticality: AssertionConfig['criticality'];
  /** L'étape (1…n) après laquelle elle se vérifie ; absente : à la fin du flow. */
  after?: number;
  support: AssertionSupport;
  /** REPLAY_ONLY : pourquoi un test autonome ne peut pas la vérifier. */
  reason?: string;
  /** NATIVE : l'attente équivalente, pour les générateurs (`stepLines`, `stepCode`, `sentenceOf`). */
  expect?: FlowExpectation;
}

function textOf(ref: ValueRef): string | undefined {
  if ('testData' in ref) return `\${testData:${ref.testData}}`;
  if ('value' in ref) return ref.value;
  return undefined;
}

/** La traduction d'une assertion déclarée. */
export function translateAssertion(assertion: AssertionConfig): TranslatedAssertion {
  const base = {
    id: assertion.id,
    description: assertion.description,
    mandatory: assertion.mandatory,
    criticality: assertion.criticality,
    ...(assertion.after !== undefined ? { after: assertion.after } : {}),
  };
  const replayOnly = (reason: string): TranslatedAssertion => ({ ...base, support: 'REPLAY_ONLY', reason });
  const native = (expect: FlowExpectation): TranslatedAssertion => ({ ...base, support: 'NATIVE', expect });
  const check = assertion.check;
  switch (check.kind) {
    case 'value': {
      if (check.source !== 'ui')
        return replayOnly(`needs the ${check.source} observed by the QA-CRAWLER replay`);
      const text = textOf(check.expected);
      return text === undefined
        ? replayOnly('needs a value extracted by the QA-CRAWLER replay')
        : native({ text });
    }
    case 'entity': {
      if (check.source !== 'ui')
        return replayOnly(`needs the ${check.source} observed by the QA-CRAWLER replay`);
      const text = textOf(check.by);
      if (text === undefined) return replayOnly('needs a value extracted by the QA-CRAWLER replay');
      return check.expect === 'absent'
        ? native({ hidden: { strategy: 'text', value: text } })
        : native({ text });
    }
    case 'state':
      return check.source === 'ui'
        ? native({ text: check.expected })
        : replayOnly(`needs the ${check.source} observed by the QA-CRAWLER replay`);
    case 'request':
      return replayOnly('needs the request observed by the QA-CRAWLER replay');
    case 'cardinality':
    case 'relation':
      return replayOnly(`needs the ${check.source} records observed by the QA-CRAWLER replay`);
    case 'transition':
      return replayOnly('needs the business states observed by the QA-CRAWLER replay');
    case 'sideEffects':
      return replayOnly('needs every write observed by the QA-CRAWLER replay');
    case 'contract':
      return replayOnly('needs the OpenAPI contract of the mission, checked by the QA-CRAWLER replay');
  }
}

export interface TranslatedAssertions {
  /** Par position d'étape (1…n) : les attentes natives à écrire juste après ; 0 : à la fin. */
  nativeAfter: Map<number, TranslatedAssertion[]>;
  replayOnly: TranslatedAssertion[];
  all: TranslatedAssertion[];
}

/** Les assertions d'un flow, réparties par étape d'ancrage. */
export function translateAssertions(
  assertions: readonly AssertionConfig[] | undefined,
  stepCount: number,
): TranslatedAssertions {
  const all = (assertions ?? []).map(translateAssertion);
  const nativeAfter = new Map<number, TranslatedAssertion[]>();
  const replayOnly: TranslatedAssertion[] = [];
  for (const assertion of all) {
    if (assertion.support !== 'NATIVE') {
      replayOnly.push(assertion);
      continue;
    }
    const position = assertion.after !== undefined && assertion.after <= stepCount ? assertion.after : 0;
    (nativeAfter.get(position) ?? nativeAfter.set(position, []).get(position))?.push(assertion);
  }
  return { nativeAfter, replayOnly, all };
}

/** L'étape `expect` synthétique d'une assertion native (pour les générateurs d'étapes). */
export function expectStepOf(assertion: TranslatedAssertion): FlowStep | undefined {
  return assertion.expect
    ? { kind: 'expect', expect: assertion.expect, allow: [], optional: false }
    : undefined;
}

/** La ligne de commentaire d'une assertion vérifiée par le rejeu seulement. */
export function replayOnlyComment(assertion: TranslatedAssertion): string {
  return `business assertion ${assertion.id} (${assertion.mandatory ? 'mandatory' : 'optional'}, ${assertion.criticality}): ${assertion.description} — verified by the QA-CRAWLER replay only: ${assertion.reason ?? ''}`;
}

/** La ligne de commentaire d'une assertion native, au-dessus de son attente. */
export function nativeComment(assertion: TranslatedAssertion): string {
  return `business assertion ${assertion.id} (${assertion.mandatory ? 'mandatory' : 'optional'}, ${assertion.criticality}): ${assertion.description}`;
}
