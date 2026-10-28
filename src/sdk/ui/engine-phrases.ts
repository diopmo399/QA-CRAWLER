/**
 * LES PHRASES DU MOTEUR (descriptions et raisons des propositions d'assertions, raisons du rejeu et de
 * la reprise) dans la langue du composant. Le moteur les écrit en anglais ; les tournures connues sont
 * traduites, une phrase inconnue s'affiche telle quelle (jamais devinée). Les noms, routes, valeurs et
 * codes cités restent intacts. tests/unit/sdk-engine-phrases.test.ts vérifie chaque tournure.
 */
const EXACT: Record<string, string> = {
  // Raisons des propositions (outcomes, assertion-proposals).
  'where the application leads': 'là où l’application mène',
  'an intermediate page (the next steps already prove it)':
    'une page intermédiaire (les étapes suivantes le prouvent déjà)',
  'a control that only the new page shows': 'un contrôle que seule la nouvelle page montre',
  'the title of the page the action leads to': 'le titre de la page où l’action mène',
  'a business state read in the response: not visible as such on the screen':
    'un état métier lu dans la réponse : pas visible tel quel à l’écran',
  'a technical call (authentication, configuration) or a list read: observed, not asserted':
    'un appel technique (authentification, configuration) ou une lecture de liste : observé, pas vérifié',
  'the write the human triggered, accepted by the server':
    'l’écriture déclenchée par la personne, acceptée par le serveur',
  'the refusal the human showed on purpose': 'le refus montré exprès par la personne',
  'a refused attempt (not kept: no checkpoint on it)':
    'une tentative refusée (non gardée : aucune vérification posée dessus)',
  'contains data (number, address, long text): depends on the values':
    'contient des données (nombre, adresse, texte long) : dépend des valeurs',
  'the validation message the human showed on purpose':
    'le message de validation montré exprès par la personne',
  'a message that may be transient (toast): kept for review':
    'un message peut-être passager (toast) : gardé pour la revue',
  'invalid fields are reported by the run (form report), not as a flow step':
    'les champs invalides sont signalés par le run (rapport des formulaires), pas comme une étape du flow',
  'row counts depend on the data already there': 'le nombre de lignes dépend des données déjà présentes',
  'outside the page: shown in the report': 'hors de la page : montré dans le rapport',
  'asked by the human (checkpoint)': 'demandé par la personne (vérification posée)',
  'asked by the human (checkpoint): the page title':
    'demandé par la personne (vérification posée) : le titre de la page',
  'contains data: kept for review': 'contient des données : gardé pour la revue',
  'the screen observed after the accepted write showed no alert and no invalid field':
    'l’écran observé après l’écriture acceptée ne montrait ni alerte ni champ invalide',
  'an error rendered without the alert role or the usual error classes is not detected':
    'une erreur affichée sans le rôle alert ni les classes d’erreur habituelles n’est pas détectée',
  'the text is looked for anywhere on the page, not in a given element':
    'le texte est cherché partout dans la page, pas dans un élément précis',
  'the request property is not identified: any field of the body carrying the value matches':
    'la propriété de la requête n’est pas identifiée : tout champ du corps qui porte la valeur convient',
  'the request body must be observed at replay': 'le corps de la requête doit être observé au rejeu',
  'the read may not be the search of that record':
    'la lecture n’est peut-être pas la recherche de cet enregistrement',
  'the response body must be observed at replay': 'le corps de la réponse doit être observé au rejeu',
  // Raisons du rejeu, étape par étape.
  'element on the screen': 'élément présent à l’écran',
  verified: 'vérifiée',
  'not reached': 'pas atteinte',
  // La reprise d'une correction (context-checkpoint).
  'the page is still in the checkpoint state': 'la page est toujours dans l’état du point de reprise',
  'the checkpoint is old: the page is verified again':
    'le point de reprise est ancien : la page est revérifiée',
  'the preconditions of the step are checked before resuming':
    'les préconditions de l’étape sont vérifiées avant de reprendre',
  'the steps that fill them are replayed': 'les étapes qui les remplissent sont rejouées',
  'an expired session is never restored automatically':
    'une session expirée n’est jamais restaurée automatiquement',
  'sign in again, then resume': 'reconnectez-vous, puis reprenez',
  'already executed in this run (creation or change): not repeated without a decision':
    'déjà fait dans ce run (création ou modification) : jamais répété sans décision',
};

const ROLES: Record<string, string> = {
  button: 'le bouton',
  link: 'le lien',
  heading: 'le titre',
  textbox: 'le champ',
  checkbox: 'la case',
  tab: 'l’onglet',
  menuitem: 'l’entrée de menu',
  combobox: 'la liste',
  dialog: 'la fenêtre',
  row: 'la ligne',
  cell: 'la cellule',
};

/** Les tournures avec des valeurs : la valeur citée est gardée telle quelle. */
const PATTERNS: [RegExp, (...groups: string[]) => string][] = [
  [
    /^the page "(.+)" \((.+)\) is displayed$/,
    (heading, route) => `la page « ${heading} » (${route}) est affichée`,
  ],
  [/^the page (\S+) is displayed$/, (route) => `la page ${route} est affichée`],
  [
    /^the (\w+) "(.+)" of (\S+) is displayed$/,
    (role, name, route) => `${ROLES[role] ?? role} « ${name} » de ${route} est affiché`,
  ],
  [/^(\S+ \S+) is accepted \((\d+)\)$/, (api, status) => `${api} est acceptée (${status})`],
  [/^(\S+ \S+) is refused \((.+)\)$/, (api, detail) => `${api} est refusée (${detail})`],
  [/^message "(.+)"$/, (text) => `message « ${text} »`],
  [/^(\d+) field\(s\) marked invalid$/, (count) => `${count} champ(s) marqué(s) invalide(s)`],
  [
    /^the list (\S+) shows (\d+) more row\(s\)$/,
    (route, count) => `la liste ${route} montre ${count} ligne(s) de plus`,
  ],
  [/^checkpoint "(.+)": page (\S+)$/, (label, route) => `vérification « ${label} » : page ${route}`],
  [
    /^checkpoint "(.+)": heading "(.+)"$/,
    (label, heading) => `vérification « ${label} » : titre « ${heading} »`,
  ],
  [/^checkpoint "(.+)": message "(.+)"$/, (label, text) => `vérification « ${label} » : message « ${text} »`],
  [
    /^(\S+ \S+) carries the value typed into "(.+)" \((.+)\)$/,
    (api, label, key) => `${api} porte la valeur saisie dans « ${label} » (${key})`,
  ],
  [/^the value of (\S+) is sent to (\S+ \S+)$/, (key, api) => `la valeur de ${key} est envoyée à ${api}`],
  [/^no error is shown after (\S+ \S+)$/, (api) => `aucune erreur n’est affichée après ${api}`],
  [
    /^(\S+ \S+) returns the record created with (\S+)$/,
    (api, key) => `${api} renvoie l’enregistrement créé avec ${key}`,
  ],
  [
    /^the record created with (\S+) is served by (\S+ \S+)$/,
    (key, api) => `l’enregistrement créé avec ${key} est servi par ${api}`,
  ],
  [
    /^testData\.(\S+) is displayed at the end of "(.+)"$/,
    (key, group) => `testData.${key} est affichée à la fin de « ${group} »`,
  ],
  [/^testData\.(\S+) is displayed$/, (key) => `testData.${key} est affichée`],
  [
    /^asked by the human: the value of testData\.(\S+) used by this run must be visible here$/,
    (key) =>
      `demandé par la personne : la valeur de testData.${key} utilisée par ce run doit être visible ici`,
  ],
  [/^(\S+) is (\w+) \((.+)\)$/, (entity, code, field) => `${entity} est ${code} (${field})`],
  [/^the checkpoint is (\d+) min old$/, (minutes) => `le point de reprise date de ${minutes} min`],
  [
    /^steps 1 to (\d+) are replayed with the same run data$/,
    (last) => `les étapes 1 à ${last} sont rejouées avec les mêmes données du run`,
  ],
];

export function enginePhrase(text: string, locale: 'fr' | 'en'): string {
  if (locale !== 'fr') return text;
  const exact = EXACT[text];
  if (exact) return exact;
  for (const [pattern, say] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return say(...match.slice(1));
  }
  return text;
}

/** Les phrases exactes traduites (tests). */
export const TRANSLATED_ENGINE_PHRASES = Object.keys(EXACT);
