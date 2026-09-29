import type { SemanticDictionary } from '../semantic-dictionary.js';
import { containsPhrase, normalizeForMatch } from './normalize.js';

/**
 * VOCABULAIRE SÉMANTIQUE DÉTERMINISTE (FR/EN) : ce que les mots d'un scénario et les
 * libellés d'un écran veulent dire. Extensible sans code : `gherkin.semanticResolution.
 * vocabulary.fields` ajoute des alias (ou des concepts), `vocabulary.actions` des mots
 * d'action. Les mots d'action reprennent les concepts du SemanticDictionary (save,
 * confirm, create, cancel, next, previous) : aucun mot n'est dupliqué.
 */
export const BUILTIN_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  email: [
    'email',
    'e-mail',
    'mail',
    'courriel',
    'adresse courriel',
    'adresse électronique',
    'adresse e-mail',
    'adresse mail',
    'email address',
    'electronic mail',
  ],
  firstName: ['prénom', 'first name', 'firstname', 'given name', 'forename'],
  lastName: ['nom', 'nom de famille', 'last name', 'lastname', 'surname', 'family name'],
  fullName: ['nom complet', 'nom et prénom', 'full name'],
  username: ["nom d'utilisateur", 'identifiant', 'username', 'user name', 'login'],
  password: ['mot de passe', 'password', 'passphrase'],
  phone: [
    'téléphone',
    'tel',
    'mobile',
    'cellulaire',
    'numéro de téléphone',
    'phone',
    'phone number',
    'telephone',
  ],
  company: [
    'entreprise',
    'société',
    'organisation',
    'raison sociale',
    'nom de la société',
    "nom de l'entreprise",
    'company',
    'company name',
    'organization',
  ],
  address: ['adresse', 'rue', 'address', 'street', 'street address'],
  city: ['ville', 'city', 'town', 'municipalité'],
  postalCode: ['code postal', 'postal code', 'zip', 'zip code'],
  country: ['pays', 'country'],
  birthDate: ['date de naissance', 'birth date', 'birthdate', 'date of birth', 'birthday'],
  startDate: ['date de début', 'start date', 'date de debut'],
  endDate: ['date de fin', 'end date'],
  role: [
    'rôle',
    'profil',
    "type d'utilisateur",
    'type de compte',
    'role',
    'profile',
    'user type',
    'account type',
  ],
  comment: ['commentaire', 'remarque', 'note', 'description', 'message', 'comment', 'notes'],
  website: ['site web', 'site internet', 'website', 'url'],
  quantity: ['quantité', 'quantity', 'qty'],
  age: ['âge', 'age'],
  gender: ['genre', 'sexe', 'gender', 'sex'],
  language: ['langue', 'language'],
  title: ['civilité', 'titre', 'title', 'salutation'],
  newsletter: ['infolettre', 'newsletter', 'abonnement'],
};

/** Ce que l'attribut autocomplete dit du champ (norme HTML). */
const AUTOCOMPLETE_CONCEPTS: Readonly<Record<string, string>> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  organization: 'company',
  'street-address': 'address',
  'address-line1': 'address',
  'address-level2': 'city',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
  bday: 'birthDate',
  username: 'username',
  'current-password': 'password',
  'new-password': 'password',
  url: 'website',
  sex: 'gender',
  language: 'language',
  'honorific-prefix': 'title',
};

/** Types de champ qu'un concept attend (et ceux qui le contredisent). */
const CONCEPT_TYPES: Readonly<Record<string, readonly string[]>> = {
  email: ['email'],
  phone: ['tel'],
  birthDate: ['date'],
  startDate: ['date', 'datetime-local'],
  endDate: ['date', 'datetime-local'],
  website: ['url'],
  quantity: ['number', 'range'],
  age: ['number'],
  password: ['password'],
  role: ['select', 'combobox', 'radio'],
  gender: ['select', 'combobox', 'radio'],
  country: ['select', 'combobox', 'text'],
  language: ['select', 'combobox'],
  title: ['select', 'combobox', 'radio', 'text'],
  newsletter: ['checkbox'],
  comment: ['textarea', 'text'],
};

export type FormActionKind = 'submit' | 'cancel' | 'next' | 'previous';

/** Mots d'action : repris des concepts du SemanticDictionary. */
const ACTION_CONCEPTS: Readonly<Record<FormActionKind, readonly string[]>> = {
  submit: ['save', 'confirm', 'create'],
  cancel: ['cancel'],
  next: ['next'],
  previous: ['previous'],
};

/** Des mots qui disent « valider » sans être dans les concepts génériques. */
const EXTRA_ACTION_WORDS: Readonly<Record<FormActionKind, readonly string[]>> = {
  submit: [
    'valider',
    'soumettre',
    'envoyer le formulaire',
    'submit',
    'terminer',
    'finish',
    'done',
    'ajouter',
  ],
  cancel: [],
  next: [],
  previous: [],
};

export interface VocabularyInput {
  fields?: Readonly<Record<string, readonly string[]>>;
  actions?: Readonly<Partial<Record<FormActionKind, readonly string[]>>>;
}

interface Alias {
  concept: string;
  alias: string;
  tokens: string[];
}

/** Un concept reconnu dans un texte, avec l'alias qui l'a révélé. */
export interface ConceptMatch {
  concept: string;
  alias: string;
  /** Le texte entier EST l'alias (« Courriel »), pas seulement le contient (« Courriel de secours »). */
  exact: boolean;
}

export class SemanticVocabulary {
  private readonly aliases: Alias[] = [];
  private readonly actionWords = new Map<FormActionKind, Alias[]>();

  constructor(dictionary: SemanticDictionary | undefined, input: VocabularyInput = {}) {
    const fields: Record<string, string[]> = {};
    for (const [concept, words] of Object.entries(BUILTIN_FIELD_ALIASES)) fields[concept] = [...words];
    for (const [concept, words] of Object.entries(input.fields ?? {}))
      fields[concept] = [...(fields[concept] ?? []), ...words];
    for (const [concept, words] of Object.entries(fields))
      for (const alias of new Set(words))
        this.aliases.push({ concept, alias, tokens: normalizeForMatch(alias).tokens });
    // Les plus longs d'abord : « adresse courriel » (email) avant « adresse » (address).
    this.aliases.sort((a, b) => b.tokens.length - a.tokens.length || a.alias.localeCompare(b.alias));

    for (const kind of Object.keys(ACTION_CONCEPTS) as FormActionKind[]) {
      const words = [
        ...ACTION_CONCEPTS[kind].flatMap((concept) => dictionary?.wordsOf(concept) ?? []),
        ...EXTRA_ACTION_WORDS[kind],
        ...(input.actions?.[kind] ?? []),
      ];
      this.actionWords.set(
        kind,
        [...new Set(words)]
          .map((alias) => ({ concept: kind, alias, tokens: normalizeForMatch(alias).tokens }))
          .filter((alias) => alias.tokens.length > 0)
          .sort((a, b) => b.tokens.length - a.tokens.length),
      );
    }
  }

  /** Les concepts de champ connus. */
  conceptNames(): string[] {
    return [...new Set(this.aliases.map((alias) => alias.concept))];
  }

  /**
   * Le concept d'un texte (libellé, name, phrase du scénario) : l'alias le plus long
   * qu'il contient, en mots entiers. « Adresse électronique » → email ; « Nom de famille »
   * → lastName ; « Prénom » → firstName (jamais lastName : « nom » n'est pas un mot de « prénom »).
   */
  conceptOf(text: string | undefined): ConceptMatch | undefined {
    const tokens = normalizeForMatch(text).tokens;
    if (tokens.length === 0) return undefined;
    for (const alias of this.aliases)
      if (containsPhrase(tokens, alias.tokens))
        return {
          concept: alias.concept,
          alias: alias.alias,
          exact: alias.tokens.length === tokens.length,
        };
    return undefined;
  }

  /** Les alias d'un concept (pour les explications). */
  aliasesOf(concept: string): string[] {
    return this.aliases.filter((alias) => alias.concept === concept).map((alias) => alias.alias);
  }

  /** Concept indiqué par l'attribut autocomplete (« given-name » → firstName). */
  conceptOfAutocomplete(autocomplete: string | undefined): string | undefined {
    if (!autocomplete) return undefined;
    // « section-x shipping given-name » : le dernier jeton est le nom du champ.
    const token = autocomplete.trim().toLowerCase().split(/\s+/).at(-1) ?? '';
    return AUTOCOMPLETE_CONCEPTS[token];
  }

  /** Types de champ attendus par un concept (vide : aucune attente). */
  expectedTypes(concept: string | undefined): readonly string[] {
    return concept ? (CONCEPT_TYPES[concept] ?? []) : [];
  }

  /** Le genre d'action de formulaire d'un libellé de bouton (« Enregistrer » → submit). */
  actionKindOf(text: string | undefined): { kind: FormActionKind; word: string } | undefined {
    const tokens = normalizeForMatch(text).tokens;
    if (tokens.length === 0) return undefined;
    let best: { kind: FormActionKind; word: string; length: number } | undefined;
    for (const [kind, aliases] of this.actionWords)
      for (const alias of aliases)
        if (containsPhrase(tokens, alias.tokens) && (!best || alias.tokens.length > best.length))
          best = { kind, word: alias.alias, length: alias.tokens.length };
    return best ? { kind: best.kind, word: best.word } : undefined;
  }

  /** Les mots d'une action de formulaire. */
  actionWordsOf(kind: FormActionKind): string[] {
    return (this.actionWords.get(kind) ?? []).map((alias) => alias.alias);
  }
}
