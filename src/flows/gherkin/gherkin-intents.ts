import type {
  AssertionIntent,
  GherkinIntent,
  IntentValue,
  SubmitIntent,
} from '../../semantics/resolution/intent.js';
import { compilePattern, valueOf, valuesOf } from './gherkin-steps.js';

/**
 * PHRASES D'INTENTION (gherkin.semanticResolution) : des phrases qui nomment un champ,
 * une page ou une action par ce qu'ils SIGNIFIENT, sans guillemets ni sélecteur :
 *
 *   Et je renseigne le prénom avec "Mohamed"      → FILL prénom
 *   Et je sélectionne "Administrateur" comme rôle  → SELECT rôle = Administrateur
 *   Et je valide le formulaire                     → SUBMIT
 *
 * Elles ne sont consultées qu'APRÈS les phrases de l'équipe et les phrases intégrées :
 * un scénario existant se traduit exactement comme avant.
 */

type StepType = 'Context' | 'Action' | 'Outcome' | 'Unknown';
type Build = (
  values: Record<string, string>,
  table: string[][] | undefined,
  type: StepType,
) => GherkinIntent | undefined;

const ELEMENT_WORDS =
  /^(?:(?:les|le|la|des|du|de la|de|un|une|mon|ma|mes|the|an|a|my)\s+|(?:l|d)['’]\s*)?(?:(bouton|lien|onglet|menu|élément de menu|case à cocher|case|champ|zone de texte|zone|liste déroulante|liste|button|link|tab|menu item|checkbox|field|text box|dropdown|list|box)\s+(?:(?:des|du|de|of|for)\s+|d['’]\s*)?)?/i;
const ROLE_OF_WORD: Record<string, string> = {
  bouton: 'button',
  button: 'button',
  lien: 'link',
  link: 'link',
  onglet: 'tab',
  tab: 'tab',
  menu: 'menuitem',
  'élément de menu': 'menuitem',
  'menu item': 'menuitem',
  case: 'checkbox',
  'case à cocher': 'checkbox',
  checkbox: 'checkbox',
};

/** « le champ du prénom » → « prénom » ; « la case "Actif" » → « Actif ». */
export function cleanName(text: string): { name: string; role?: string } {
  let name = text.trim().replace(/^["«“']\s*|\s*["»”']$/g, '');
  let role: string | undefined;
  for (let pass = 0; pass < 3; pass++) {
    const match = ELEMENT_WORDS.exec(name);
    if (!match || match[0].length === 0) break;
    const word = match[1]?.toLowerCase();
    if (word && ROLE_OF_WORD[word]) role ??= ROLE_OF_WORD[word];
    name = name.slice(match[0].length).trim();
  }
  name = name
    .replace(/\s+(?:field|champ|box)$/i, '')
    .replace(/^["«“']\s*|\s*["»”']$/g, '')
    .trim();
  return { name, ...(role ? { role } : {}) };
}

const PAGE_WORDS =
  /^(?:(?:la|le|the)\s+|l['’]\s*)?(?:page|écran|ecran|section|rubrique|onglet|menu|module|screen|tab)\s+(?:(?:des|de la|du|de|of the|of)\s+|d['’]\s*)?/i;

/** « la page des utilisateurs » → « utilisateurs » ; « the users page » → « users ». */
export function cleanPage(text: string): string {
  let name = text.trim().replace(/^["«“']\s*|\s*["»”']$/g, '');
  name = name.replace(PAGE_WORDS, '').trim();
  name = name.replace(/\s+(?:page|screen|tab|section)$/i, '').trim();
  name = cleanName(name).name;
  return name;
}

/** « l'utilisateur », « un nouvel utilisateur », « the new user » → « utilisateur ». */
function cleanEntity(text: string): string {
  return cleanName(text)
    .name.replace(/^(?:nouvel|nouvelle|nouveau|new)\s+/i, '')
    .trim();
}

function table2rows(table: string[][] | undefined): { field: string; value: IntentValue }[] | undefined {
  if (!table || table.length === 0) return undefined;
  return table
    .filter(
      (row, index) =>
        !(
          index === 0 &&
          /^(champ|field|libellé|label)$/i.test(row[0] ?? '') &&
          /^(valeur|value)$/i.test(row[1] ?? '')
        ),
    )
    .map((row) => {
      if (row.length !== 2)
        throw new Error('each row of the table needs exactly two cells: | field | value |');
      return { field: cleanName(row[0] ?? '').name, value: valueOf(row[1] ?? '') };
    });
}

const submit =
  (action: SubmitIntent['action']): Build =>
  (_values, _table, type) =>
    type === 'Outcome' ? undefined : { kind: 'SUBMIT', action };

const verbSubmit =
  (verb: string): Build =>
  (_values, _table, type) =>
    type === 'Outcome' ? undefined : { kind: 'SUBMIT', action: 'submit', verb };

const assertion =
  (kind: AssertionIntent['assertion'], message?: AssertionIntent['message']): Build =>
  (values) => {
    const subject = values.cible
      ? cleanPage(values.cible)
      : values.entité
        ? cleanEntity(values.entité)
        : undefined;
    return {
      kind: 'ASSERT',
      assertion: kind,
      ...(subject ? { subject } : {}),
      ...(message ? { message } : {}),
    };
  };

/** Les phrases d'intention, FR puis EN. L'ordre compte : le plus précis d'abord. */
const INTENT_SENTENCES: [string[], Build][] = [
  // ---- formulaire complet (avant « je remplis {champ} avec {valeur} »)
  [
    [
      'je remplis le formulaire {formulaire:texte} avec',
      'je remplis le formulaire avec',
      'je remplis le formulaire {formulaire:texte}',
      'je remplis le formulaire',
      'I fill in the {formulaire:texte} form with',
      'I fill in the form with',
      'I fill in the {formulaire:texte} form',
      'I fill in the form',
      'I fill the form',
    ],
    (values, table, type) => {
      if (type === 'Outcome') return undefined;
      const form = values.formulaire ? cleanEntity(values.formulaire) : undefined;
      const rows = table2rows(table);
      return { kind: 'FILL_FORM', ...(form ? { form } : {}), ...(rows ? { rows } : {}) };
    },
  ],
  // ---- vérifications (Alors)
  [
    [
      'un message de confirmation est affiché',
      'un message de confirmation s’affiche',
      "un message de confirmation s'affiche",
      'un message de succès est affiché',
      'un message de succès s’affiche',
      "un message de succès s'affiche",
      'je vois un message de confirmation',
      'je vois un message de succès',
      'a confirmation message is displayed',
      'a confirmation message is shown',
      'a success message is displayed',
      'a success message is shown',
      'I see a confirmation message',
      'I see a success message',
    ],
    assertion('MESSAGE', 'confirmation'),
  ],
  [
    [
      "un message d'erreur est affiché",
      'un message d’erreur est affiché',
      "un message d'erreur s'affiche",
      "je vois un message d'erreur",
      'an error message is displayed',
      'an error message is shown',
      'I see an error message',
    ],
    assertion('MESSAGE', 'error'),
  ],
  [
    [
      'la page {cible:texte} est affichée',
      'la page {cible:texte} s’affiche',
      "la page {cible:texte} s'affiche",
      "l'écran {cible:texte} est affiché",
      'je vois la page {cible:texte}',
      'the {cible:texte} page is displayed',
      'the {cible:texte} page is shown',
      'the page {cible:texte} is displayed',
      'I see the {cible:texte} page',
    ],
    assertion('PAGE_DISPLAYED'),
  ],
  [
    [
      '{entité:texte} doit apparaître dans la liste',
      '{entité:texte} doit apparaitre dans la liste',
      '{entité:texte} apparaît dans la liste',
      '{entité:texte} apparait dans la liste',
      '{entité:texte} est affiché dans la liste',
      '{entité:texte} est affichée dans la liste',
      '{entité:texte} figure dans la liste',
      '{entité:texte} should appear in the list',
      '{entité:texte} appears in the list',
      '{entité:texte} is displayed in the list',
      '{entité:texte} is listed',
    ],
    assertion('ENTITY_VISIBLE'),
  ],
  [
    [
      '{entité:texte} doit être créé',
      '{entité:texte} doit être créée',
      '{entité:texte} est créé',
      '{entité:texte} est créée',
      '{entité:texte} a été créé',
      '{entité:texte} a été créée',
      '{entité:texte} doit être enregistré',
      '{entité:texte} doit être enregistrée',
      '{entité:texte} est enregistré',
      '{entité:texte} est enregistrée',
      '{entité:texte} should be created',
      '{entité:texte} is created',
      '{entité:texte} has been created',
      '{entité:texte} should be saved',
      '{entité:texte} is saved',
      '{entité:texte} has been saved',
    ],
    assertion('ENTITY_CREATED'),
  ],
  // ---- choix
  [
    [
      'je sélectionne {option} comme {champ:texte}',
      'je choisis {option} comme {champ:texte}',
      'je sélectionne {option} dans {champ:texte}',
      'je choisis {option} dans {champ:texte}',
      'je sélectionne {option} pour {champ:texte}',
      'je choisis {option} pour {champ:texte}',
      'I select {option} as {champ:texte}',
      'I choose {option} as {champ:texte}',
      'I select {option} from {champ:texte}',
      'I select {option} in {champ:texte}',
      'I select {option} for {champ:texte}',
      'I choose {option} from {champ:texte}',
      'I choose {option} in {champ:texte}',
      'I choose {option} for {champ:texte}',
    ],
    (values, _table, type) =>
      type === 'Outcome'
        ? undefined
        : { kind: 'SELECT', field: cleanName(values.champ ?? '').name, option: values.option ?? '' },
  ],
  // ---- fichiers (reconnus pour être refusés proprement : jamais de téléversement automatique)
  [
    [
      'je joins {fichier} dans {champ:texte}',
      'je joins {fichier} à {champ:texte}',
      'je téléverse {fichier} dans {champ:texte}',
      'I upload {fichier} to {champ:texte}',
      'I upload {fichier} into {champ:texte}',
      'I attach {fichier} to {champ:texte}',
    ],
    (values) => ({ kind: 'UPLOAD', field: cleanName(values.champ ?? '').name, file: values.fichier ?? '' }),
  ],
  // ---- saisie
  [
    [
      'je saisis {valeur} dans {champ:texte}',
      'je saisis {valeur} comme {champ:texte}',
      'je tape {valeur} dans {champ:texte}',
      "j'entre {valeur} dans {champ:texte}",
      "j'écris {valeur} dans {champ:texte}",
      'je mets {valeur} dans {champ:texte}',
      'I type {valeur} in {champ:texte}',
      'I type {valeur} into {champ:texte}',
      'I enter {valeur} in {champ:texte}',
      'I enter {valeur} into {champ:texte}',
      'I enter {valeur} as {champ:texte}',
      'I put {valeur} in {champ:texte}',
    ],
    (values, _table, type) =>
      type === 'Outcome'
        ? undefined
        : { kind: 'FILL', field: cleanName(values.champ ?? '').name, value: valueOf(values.valeur ?? '') },
  ],
  [
    [
      'je renseigne {champ:texte} avec {valeur:texte}',
      'je remplis {champ:texte} avec {valeur:texte}',
      'je complète {champ:texte} avec {valeur:texte}',
      'je renseigne {champ:texte} à {valeur}',
      'I fill in {champ:texte} with {valeur:texte}',
      'I fill {champ:texte} with {valeur:texte}',
      'I set {champ:texte} to {valeur:texte}',
    ],
    (values, _table, type) =>
      type === 'Outcome'
        ? undefined
        : { kind: 'FILL', field: cleanName(values.champ ?? '').name, value: valueOf(values.valeur ?? '') },
  ],
  // ---- cases à cocher
  [
    ['je décoche {champ:texte}', 'I uncheck {champ:texte}', 'I untick {champ:texte}'],
    (values) => ({ kind: 'CHECK', field: cleanName(values.champ ?? '').name, checked: false }),
  ],
  [
    ['je coche {champ:texte}', 'I check {champ:texte}', 'I tick {champ:texte}'],
    (values) => ({ kind: 'CHECK', field: cleanName(values.champ ?? '').name, checked: true }),
  ],
  // ---- actions de formulaire
  [['je valide le formulaire', 'je valide', 'je valide la saisie'], verbSubmit('valider')],
  [['je soumets le formulaire', 'je soumets', "j'envoie le formulaire"], verbSubmit('soumettre')],
  [
    ["j'enregistre", "j'enregistre le formulaire", "j'enregistre les modifications", 'je sauvegarde'],
    verbSubmit('enregistrer'),
  ],
  [['je confirme', 'je confirme la saisie'], verbSubmit('confirmer')],
  [['I submit the form', 'I submit', 'I validate the form'], verbSubmit('submit')],
  [['I save', 'I save the form', 'I save the changes'], verbSubmit('save')],
  [['I confirm'], verbSubmit('confirm')],
  [["j'annule", "j'annule la saisie", 'I cancel', 'I cancel the form'], submit('cancel')],
  [
    [
      "je passe à l'étape suivante",
      'je passe à la suite',
      'je continue',
      'I go to the next step',
      'I continue',
      'I proceed',
    ],
    submit('next'),
  ],
  [
    ["je reviens à l'étape précédente", 'je reviens en arrière', 'I go back', 'I go to the previous step'],
    submit('previous'),
  ],
  // ---- clic nommé sans guillemets
  [
    [
      'je clique sur {cible:texte}',
      "j'appuie sur {cible:texte}",
      'I click on {cible:texte}',
      'I click {cible:texte}',
      'I press {cible:texte}',
    ],
    (values, _table, type) => {
      if (type === 'Outcome') return undefined;
      const { name, role } = cleanName(values.cible ?? '');
      return { kind: 'CLICK', target: name, ...(role ? { role } : {}) };
    },
  ],
  // ---- navigation
  [
    ['je suis sur {cible:texte}', "l'utilisateur est sur {cible:texte}", 'I am on {cible:texte}'],
    (values, _table, type) =>
      type === 'Outcome'
        ? { kind: 'ASSERT', assertion: 'PAGE_DISPLAYED', subject: cleanPage(values.cible ?? '') }
        : { kind: 'NAVIGATE', target: cleanPage(values.cible ?? ''), precondition: true },
  ],
  [
    [
      'je vais dans {cible:texte}',
      'je vais sur {cible:texte}',
      'je vais à {cible:texte}',
      'je vais aux {cible:texte}',
      "j'ouvre {cible:texte}",
      "j'accède à {cible:texte}",
      "j'accède aux {cible:texte}",
      "j'accède au {cible:texte}",
      'je navigue vers {cible:texte}',
      'je consulte {cible:texte}',
      'I go to {cible:texte}',
      'I open {cible:texte}',
      'I navigate to {cible:texte}',
      'I visit {cible:texte}',
      'I access {cible:texte}',
    ],
    (values, _table, type) =>
      type === 'Outcome' ? undefined : { kind: 'NAVIGATE', target: cleanPage(values.cible ?? '') },
  ],
];

interface IntentDefinition {
  regex: RegExp;
  names: string[];
  build: Build;
}

/** Traduit une phrase Gherkin en intention ; undefined quand aucune phrase d'intention ne correspond. */
export class GherkinIntentParser {
  private readonly definitions: IntentDefinition[] = INTENT_SENTENCES.flatMap(([patterns, build]) =>
    patterns.map((pattern) => ({ ...compilePattern(pattern), build })),
  );

  parse(text: string, type: StepType = 'Unknown', table?: string[][]): GherkinIntent | undefined {
    const sentence = text
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.!]+$/, '');
    for (const definition of this.definitions) {
      const match = definition.regex.exec(sentence);
      if (!match) continue;
      const intent = definition.build(valuesOf(match, definition.names), table, type);
      if (intent && isComplete(intent)) return intent;
    }
    return undefined;
  }
}

/** Une intention sans nom de champ ou de cible n'en est pas une. */
function isComplete(intent: GherkinIntent): boolean {
  switch (intent.kind) {
    case 'FILL':
    case 'SELECT':
    case 'CHECK':
    case 'UPLOAD':
      return intent.field.length > 0;
    case 'NAVIGATE':
    case 'CLICK':
      return intent.target.length > 0;
    default:
      return true;
  }
}

/** Les phrases d'intention reconnues (aide et documentation). */
export function intentSentences(): string[] {
  return INTENT_SENTENCES.flatMap(([patterns]) => patterns);
}
