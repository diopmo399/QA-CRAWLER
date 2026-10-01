import { semanticKeyOf } from '../data/test-data-provider.js';
import { sensitivityOf } from '../policies/sensitive-fields.js';
import type { RecordedElement, RecordedValue, RecordedValueFacts } from './model.js';

export interface ValueClassifierOptions {
  /** Variables d'environnement des identifiants (jamais leurs valeurs). */
  usernameEnv: string;
  passwordEnv: string;
}

const USERNAME = /^(user(name)?|login|identifiant|utilisateur|courriel de connexion)$/i;

/**
 * La valeur d'une action enregistrée, SANS la saisie :
 *   SENSITIVE_REFERENCE     mot de passe, secret, identifiant de connexion → { env: … }
 *   LITERAL_BUSINESS_VALUE  un choix de l'interface (option, radio, case) : son libellé
 *   PREEXISTING_VALUE       la valeur trouvée dans le champ, inchangée → aucune étape
 *   GENERATED_TEST_DATA     une saisie libre → { testData: email | firstName | … } (une
 *                           valeur valide choisie au rejeu par le TestDataProvider)
 * Une saisie libre n'est JAMAIS gardée : le navigateur n'en envoie que la forme.
 */
export function classifyRecordedValue(
  element: RecordedElement,
  facts: RecordedValueFacts | undefined,
  options: ValueClassifierOptions,
): RecordedValue {
  const label = element.label ?? element.name;
  const sensitivity = sensitivityOf({
    ...(element.inputType ? { inputType: element.inputType } : {}),
    ...(element.autocomplete ? { autocomplete: element.autocomplete } : {}),
    ...(label ? { label } : {}),
    ...(element.nameAttr ? { name: element.nameAttr } : {}),
    ...(element.placeholder ? { placeholder: element.placeholder } : {}),
    ...(element.elementId ? { elementId: element.elementId } : {}),
  });
  if (facts?.sensitive || sensitivity.sensitive) {
    const env = sensitivity.payment
      ? `QA_${envKey((element.formControlName ?? element.nameAttr ?? label) || 'SECRET')}`
      : /password|passe|pwd/i.test(
            `${element.inputType ?? ''} ${element.autocomplete ?? ''} ${label} ${element.nameAttr ?? ''}`,
          )
        ? options.passwordEnv
        : `QA_${envKey((element.formControlName ?? element.nameAttr ?? label) || 'SECRET')}`;
    return {
      class: 'SENSITIVE_REFERENCE',
      env,
      sensitive: true,
      reason: `sensitive field (${sensitivity.reason ?? 'browser'}): read from ${env}, never recorded`,
    };
  }
  if (
    element.autocomplete === 'username' ||
    USERNAME.test(element.nameAttr ?? '') ||
    USERNAME.test(element.formControlName ?? '') ||
    USERNAME.test(label)
  )
    return {
      class: 'SENSITIVE_REFERENCE',
      env: options.usernameEnv,
      sensitive: true,
      reason: `sign-in identifier: read from ${options.usernameEnv}`,
    };
  if (facts?.option)
    return {
      class: 'LITERAL_BUSINESS_VALUE',
      literal: facts.option.label,
      sensitive: false,
      reason: `a choice of the screen ("${facts.option.label}"${facts.option.value ? `, code ${facts.option.value}` : ''})`,
    };
  if (facts && facts.digest !== undefined && facts.digest === facts.initialDigest)
    return {
      class: 'PREEXISTING_VALUE',
      sensitive: false,
      reason: 'the value already in the field was kept: nothing to replay',
    };
  if (facts?.empty)
    return {
      class: 'LITERAL_BUSINESS_VALUE',
      literal: '',
      sensitive: false,
      reason: 'the field was emptied',
    };
  const key = testDataKey(element, facts);
  return {
    class: 'GENERATED_TEST_DATA',
    testData: key,
    sensitive: false,
    reason: `typed ${facts ? `${facts.shape} (${String(facts.length)} characters)` : 'value'}: a valid "${key}" chosen by the test data provider at replay`,
  };
}

/** La clé d'une donnée de test : le sens du champ (email, firstName…), sinon sa forme, sinon son nom. */
export function testDataKey(element: RecordedElement, facts?: RecordedValueFacts): string {
  // Le nom technique d'un test id (PrenomContact_input) dit aussi le sens du champ.
  const fromTestId = element.testId?.replace(/[-_]?(input|field|champ|select|txt)$/i, '');
  const names = [
    element.formControlName,
    element.nameAttr,
    element.label,
    element.guessedLabel,
    element.name,
    fromTestId,
  ].filter((text): text is string => text !== undefined && text.trim() !== '');
  const semantic = semanticKeyOf({
    ...(element.inputType ? { type: element.inputType } : {}),
    name: names.join(' '),
    ...(element.placeholder ? { placeholder: element.placeholder } : {}),
  });
  if (semantic && semantic !== 'text') return semantic;
  // Le nom du champ (pour testData.fields de la mission), sinon sa forme.
  const named = names.map(camel).find((key) => key !== '');
  if (named) return named;
  if (facts && ['email', 'phone', 'url', 'date', 'number'].includes(facts.shape)) return facts.shape;
  return 'text';
}

function camel(text: string | undefined): string {
  const words = (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}`,
    )
    .join('');
}

function envKey(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
      .slice(0, 40) || 'SECRET'
  );
}
