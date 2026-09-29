/**
 * DICTIONNAIRE DE PHRASES GHERKIN : chaque phrase type devient une étape de flow (la
 * même forme que dans le YAML). Aucune interprétation libre : une phrase correspond
 * à un modèle, ou c'est une erreur explicite. Les valeurs sont toujours entre
 * guillemets : "…", « … » ou '…'.
 *
 * Un modèle s'écrit comme la phrase, avec des emplacements nommés : `je clique sur {cible}`.
 * `{élément}` devant une cible (« le bouton », « le lien », « l'onglet »…) choisit le rôle.
 * Dans les phrases de l'équipe, `{x:mot}` accepte aussi un mot sans guillemets (`112310`)
 * et `{x:texte}` n'importe quel texte (le plus court possible).
 */

/** Une étape de flow brute, validée ensuite par le schéma des flows (comme une étape écrite en YAML). */
export type RawStep = Record<string, unknown>;

/**
 * Une phrase personnalisée de la mission : `pattern` avec des `{emplacements}`, et ce
 * qu'elle produit — une étape (`step`), plusieurs (`steps`, dont `run: <flow>` pour
 * rejouer un flow), ou une vérification manuelle (`manual: true`). `allow` s'ajoute à
 * chaque étape produite (MUTATION pour une phrase qui enregistre).
 */
export interface CustomGherkinStep {
  pattern: string;
  step?: RawStep;
  steps?: RawStep[];
  manual?: boolean;
  allow?: string | string[];
}

interface Definition {
  regex: RegExp;
  names: string[];
  build(values: Record<string, string>, table: string[][] | undefined, sentence: string): RawStep[];
}

/** Types d'éléments nommés dans une phrase → rôle ARIA. */
const ELEMENT_ROLES: [RegExp, string][] = [
  [/^(?:le |the |a )?(?:bouton|button)$/i, 'button'],
  [/^(?:le |the |a )?(?:lien|link)$/i, 'link'],
  [/^(?:l'|l’|the |a )?(?:onglet|tab)$/i, 'tab'],
  [/^(?:le |the |a )?(?:menu|élément de menu|menu item)$/i, 'menuitem'],
  [/^(?:la |the |a )?(?:case(?: à cocher)?|checkbox)$/i, 'checkbox'],
  [/^(?:le |the |a )?(?:bouton radio|option|radio(?: button)?)$/i, 'radio'],
  [/^(?:le |the |a )?(?:champ|field|zone de texte|text box)$/i, 'textbox'],
  [/^(?:la |the |a )?(?:liste(?: déroulante)?|list|dropdown|combo(?:box)?)$/i, 'combobox'],
];

const QUOTED = String.raw`(?:"([^"]*)"|«\s*([^»]*?)\s*»|“([^”]*)”|'([^']*)')`;
/** Une valeur entre guillemets, ou un mot sans guillemets (la 4e forme remplace '…'). */
const WORD = String.raw`(?:"([^"]*)"|«\s*([^»]*?)\s*»|“([^”]*)”|([^\s"«“]+))`;
/** Une valeur entre guillemets, ou n'importe quel texte. */
const TEXT = String.raw`(?:"([^"]*)"|«\s*([^»]*?)\s*»|“([^”]*)”|(.+?))`;
const ELEMENT = String.raw`(?:(le bouton|le lien|l['’]onglet|le menu|l['’]élément de menu|la case à cocher|la case|le bouton radio|l['’]option|le champ|la zone de texte|la liste déroulante|la liste|the button|the link|the tab|the menu item|the menu|the checkbox|the radio button|the option|the field|the text box|the dropdown|the list|button|link|tab|checkbox|field|dropdown)\s+)?`;

/**
 * Compile un modèle : les espaces sont souples, la casse compte peu (« Je clique »,
 * « je clique »), un « : » final est facultatif, `{x}` capture une valeur entre guillemets
 * et `{élément}` un type d'élément facultatif. Retourne aussi l'ordre des emplacements.
 */
export function compilePattern(pattern: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  let source = '';
  for (const part of pattern
    .trim()
    .replace(/\s*:$/, '')
    .split(/(\{[^}]+\})/)) {
    const slot = /^\{([^}]+)\}$/.exec(part);
    if (slot?.[1] === 'élément' || slot?.[1] === 'element') {
      names.push('élément');
      source += ELEMENT;
    } else if (slot?.[1]) {
      // Quatre groupes : une valeur par forme de guillemets (ou sans guillemets pour :mot et :texte).
      const [name = '', type] = slot[1].split(':').map((piece) => piece.trim());
      names.push(name, '', '', '');
      source +=
        type === 'mot' || type === 'word' ? WORD : type === 'texte' || type === 'text' ? TEXT : QUOTED;
    } else {
      source += part
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/['’]/g, "['’]")
        .replace(/\s+/g, '\\s+');
    }
  }
  return { regex: new RegExp(`^${source}\\s*:?$`, 'i'), names };
}

/** Les valeurs capturées, par nom d'emplacement (la première alternative de guillemets qui a capturé). */
export function valuesOf(match: RegExpExecArray, names: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  names.forEach((name, index) => {
    if (!name) return;
    if (name === 'élément') {
      const value = match[index + 1];
      if (value !== undefined) values[name] = value;
      return;
    }
    const value = [1, 2, 3, 4].map((offset) => match[index + offset]).find((v) => v !== undefined);
    if (value !== undefined) values[name] = value;
  });
  return values;
}

/** « le bouton » → button ; rien → undefined. */
function roleOf(element: string | undefined): string | undefined {
  if (!element) return undefined;
  const clean = element.trim().replace(/’/g, "'");
  return ELEMENT_ROLES.find(([regex]) => regex.test(clean))?.[1];
}

/** La cible d'un clic : rôle + nom si l'élément est nommé, sinon le texte visible. */
function clickTarget(values: Record<string, string>): RawStep {
  const name = values.cible ?? '';
  const role = roleOf(values.élément);
  if (role === 'textbox' || role === 'combobox') return { label: name };
  return role ? { role, name } : { text: name };
}

/** La cible d'un champ : son libellé (ou un rôle nommé explicitement). */
function fieldTarget(values: Record<string, string>): RawStep {
  const name = values.champ ?? values.cible ?? '';
  const role = roleOf(values.élément);
  return role && role !== 'textbox' && role !== 'combobox' ? { role, name } : { label: name };
}

/** `<env:NOM>` → { env: NOM } : un secret n'est jamais écrit dans le fichier .feature. */
export function valueOf(text: string): string | { env: string } {
  const env = /^<env:([A-Za-z_][A-Za-z0-9_]*)>$/.exec(text.trim());
  return env?.[1] ? { env: env[1] } : text;
}

/** Un tableau champ | valeur → une saisie par ligne (l'en-tête « champ | valeur » est ignoré). */
function fillTable(table: string[][] | undefined): RawStep[] {
  if (!table || table.length === 0) throw new Error('a data table | field | value | is expected');
  const rows = table.filter(
    (row, index) =>
      !(
        index === 0 &&
        /^(champ|field|libellé|label)$/i.test(row[0] ?? '') &&
        /^(valeur|value)$/i.test(row[1] ?? '')
      ),
  );
  return rows.map((row) => {
    if (row.length !== 2) throw new Error('each row of the table needs exactly two cells: | field | value |');
    return { fill: { label: row[0] ?? '', value: valueOf(row[1] ?? '') } };
  });
}

type Builder = (values: Record<string, string>, table: string[][] | undefined) => RawStep | RawStep[];

/** Les phrases intégrées, en français puis en anglais. */
const BUILTIN: [string[], Builder][] = [
  [
    [
      'je suis sur {url}',
      'je suis sur la page {url}',
      'je vais sur {url}',
      'je vais sur la page {url}',
      "j'ouvre {url}",
      "j'ouvre la page {url}",
      'je navigue vers {url}',
      "l'utilisateur est sur {url}",
      'I am on {url}',
      'I am on the page {url}',
      'I go to {url}',
      'I open {url}',
      'I visit {url}',
      'I navigate to {url}',
    ],
    (values) => ({ goto: values.url }),
  ],
  [
    [
      'je clique sur {élément}{cible}',
      "j'appuie sur {élément}{cible}",
      'je sélectionne {élément}{cible}',
      "j'ouvre {élément}{cible}",
      'I click {élément}{cible}',
      'I click on {élément}{cible}',
      'I press {élément}{cible}',
      'I open {élément}{cible}',
    ],
    (values) => ({ click: clickTarget(values) }),
  ],
  [
    [
      'je saisis {valeur} dans {élément}{champ}',
      'je tape {valeur} dans {élément}{champ}',
      "j'entre {valeur} dans {élément}{champ}",
      "j'écris {valeur} dans {élément}{champ}",
      'je remplis {élément}{champ} avec {valeur}',
      'I type {valeur} in {élément}{champ}',
      'I type {valeur} into {élément}{champ}',
      'I enter {valeur} in {élément}{champ}',
      'I enter {valeur} into {élément}{champ}',
      'I fill {élément}{champ} with {valeur}',
      'I fill in {élément}{champ} with {valeur}',
    ],
    (values) => ({ fill: { ...fieldTarget(values), value: valueOf(values.valeur ?? '') } }),
  ],
  [
    [
      'je remplis le formulaire :',
      'je remplis les champs :',
      'je remplis :',
      'je saisis :',
      'I fill in the form:',
      'I fill in:',
      'I fill in the fields:',
    ],
    (_values, table) => fillTable(table),
  ],
  [
    [
      'je choisis {option} dans {élément}{champ}',
      'je sélectionne {option} dans {élément}{champ}',
      'I select {option} from {élément}{champ}',
      'I select {option} in {élément}{champ}',
      'I choose {option} from {élément}{champ}',
      'I choose {option} in {élément}{champ}',
    ],
    (values) => ({ select: { label: values.champ ?? '', option: values.option ?? '' } }),
  ],
  [
    ['je coche {élément}{cible}', 'I check {élément}{cible}', 'I tick {élément}{cible}'],
    (values) => ({ check: fieldTarget(values) }),
  ],
  [
    ['je décoche {élément}{cible}', 'I uncheck {élément}{cible}', 'I untick {élément}{cible}'],
    (values) => ({ uncheck: fieldTarget(values) }),
  ],
  [
    [
      'je ne vois pas {élément}{cible}',
      'je ne dois pas voir {élément}{cible}',
      'je ne devrais pas voir {élément}{cible}',
      "{élément}{cible} n'est pas affiché",
      "{élément}{cible} n'est pas visible",
      'I do not see {élément}{cible}',
      "I don't see {élément}{cible}",
      'I should not see {élément}{cible}',
      '{élément}{cible} is not visible',
    ],
    (values) => {
      const role = roleOf(values.élément);
      const name = values.cible ?? '';
      return { expect: { hidden: role ? { role, name } : { text: name } } };
    },
  ],
  [
    [
      'je vois {élément}{cible}',
      'je dois voir {élément}{cible}',
      'je devrais voir {élément}{cible}',
      'la page affiche {cible}',
      '{élément}{cible} est affiché',
      '{élément}{cible} est visible',
      '{élément}{cible} s’affiche',
      "{élément}{cible} s'affiche",
      'le message {cible} est affiché',
      'le message {cible} s’affiche',
      "le message {cible} s'affiche",
      'I see {élément}{cible}',
      'I should see {élément}{cible}',
      'the page shows {cible}',
      '{élément}{cible} is visible',
      '{élément}{cible} is displayed',
      'the message {cible} is displayed',
    ],
    (values) => {
      const role = roleOf(values.élément);
      const name = values.cible ?? '';
      return { expect: role ? { visible: { role, name } } : { text: name } };
    },
  ],
  [
    [
      "l'URL contient {url}",
      "l'adresse contient {url}",
      'je suis redirigé vers {url}',
      'je suis redirigée vers {url}',
      'je suis sur la page de {url}',
      'the URL contains {url}',
      'I am redirected to {url}',
    ],
    (values) => ({ expect: { url: values.url } }),
  ],
  [
    [
      "aucun message d'erreur n'est affiché",
      "aucun message d'erreur ne s'affiche",
      "aucune erreur n'est affichée",
      "aucun message d'erreur n'est affiché à l'utilisateur",
      "je ne vois aucun message d'erreur",
      'no error message is displayed',
      'no error message is shown',
      'no error is displayed',
      'I see no error message',
      'I should not see any error message',
    ],
    () => ({ expect: { noError: true } }),
  ],
  [
    [
      'la requête {méthode:mot} {url} réussit',
      'la requête {url} réussit',
      "l'appel {méthode:mot} {url} réussit",
      "l'appel {url} réussit",
      'la requête {méthode:mot} {url} répond {statut:mot}',
      'la requête {url} répond {statut:mot}',
      'the request {méthode:mot} {url} succeeds',
      'the request {url} succeeds',
      'the call {méthode:mot} {url} succeeds',
      'the call {url} succeeds',
      'the request {méthode:mot} {url} responds {statut:mot}',
      'the request {url} responds {statut:mot}',
    ],
    (values) => ({
      expect: {
        response: {
          ...(values.méthode ? { method: values.méthode.toUpperCase() } : {}),
          url: values.url,
          ...(values.statut
            ? { status: /^\d+$/.test(values.statut) ? Number(values.statut) : values.statut.toLowerCase() }
            : {}),
        },
      },
    }),
  ],
  [
    [
      'je prends une capture {nom}',
      "je prends une capture d'écran {nom}",
      "je fais une capture d'écran {nom}",
      'I take a screenshot {nom}',
      'I take a screenshot named {nom}',
    ],
    (values) => ({ screenshot: values.nom }),
  ],
];

/** Remplace `{emplacement}` par sa valeur dans toutes les chaînes d'une étape personnalisée. */
function substitute(template: unknown, values: Record<string, string>): unknown {
  if (typeof template === 'string') {
    // `{code}` ou `{code:mot}` : le nom de l'emplacement, sans son type.
    const nameOf = (slot: string): string => slot.split(':')[0]?.trim() ?? slot;
    const whole = /^\{([^}]+)\}$/.exec(template);
    const wholeValue = whole?.[1] !== undefined ? values[nameOf(whole[1])] : undefined;
    if (wholeValue !== undefined) return valueOf(wholeValue);
    return template.replace(/\{([^}]+)\}/g, (all, slot: string) => values[nameOf(slot)] ?? all);
  }
  if (Array.isArray(template)) return template.map((item) => substitute(item, values));
  if (template !== null && typeof template === 'object')
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>).map(([key, value]) => [
        key,
        substitute(value, values),
      ]),
    );
  return template;
}

/** Les étapes d'une phrase de l'équipe, avec ses valeurs, et son `allow` ajouté à chacune. */
function customSteps(entry: CustomGherkinStep, values: Record<string, string>, sentence: string): RawStep[] {
  if (entry.manual) return [{ manual: sentence }];
  const templates = entry.steps ?? (entry.step ? [entry.step] : []);
  const allow = entry.allow === undefined ? [] : Array.isArray(entry.allow) ? entry.allow : [entry.allow];
  return templates.map((template) => {
    const step = substitute(template, values) as RawStep;
    if (allow.length === 0) return step;
    const own = step.allow === undefined ? [] : Array.isArray(step.allow) ? step.allow : [step.allow];
    return { ...step, allow: [...new Set([...(own as string[]), ...allow])] };
  });
}

/**
 * Traduit des phrases Gherkin en étapes de flow. `translate` renvoie undefined pour
 * une phrase inconnue : l'appelant en fait une erreur avec le fichier et la ligne.
 */
export class GherkinStepDictionary {
  private readonly definitions: Definition[] = [];

  constructor(custom: readonly CustomGherkinStep[] = []) {
    // Les phrases de la mission d'abord : elles ont le dernier mot.
    for (const entry of custom)
      this.definitions.push({
        ...compilePattern(entry.pattern),
        build: (values, _table, sentence) => customSteps(entry, values, sentence),
      });
    for (const [patterns, builder] of BUILTIN)
      for (const pattern of patterns)
        this.definitions.push({
          ...compilePattern(pattern),
          build: (values, table) => {
            const built = builder(values, table);
            return Array.isArray(built) ? built : [built];
          },
        });
  }

  translate(text: string, table?: string[][]): RawStep[] | undefined {
    const sentence = text.trim().replace(/\s+/g, ' ');
    for (const definition of this.definitions) {
      const match = definition.regex.exec(sentence);
      if (match) return definition.build(valuesOf(match, definition.names), table, sentence);
    }
    return undefined;
  }
}

/** Les phrases reconnues (pour l'aide et la documentation). */
export function builtinSentences(): string[] {
  return BUILTIN.flatMap(([patterns]) => patterns);
}
