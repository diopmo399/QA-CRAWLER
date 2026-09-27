import {
  DETAILS_KEYWORDS,
  EXPORT_KEYWORDS,
  FILTER_KEYWORDS,
  KeywordMatcher,
  normalizeText,
  RISK_KEYWORDS,
  SEARCH_KEYWORDS,
} from '../policies/keywords.js';

/**
 * Concepts d'interface connus du moteur. Chacun est une liste de mots (toutes
 * langues confondues) : « create » = create, add, new, ajouter, créer, nouveau…
 * Les listes du moteur (keywords.ts) sont reprises telles quelles quand elles
 * existent : aucun mot-clé n'est dupliqué ailleurs dans le code.
 */
export const BUILTIN_CONCEPTS = {
  create: [
    'create',
    'add',
    'new',
    'ajouter',
    'creer',
    'creation',
    'nouveau',
    'nouvel',
    'nouvelle',
    'nouveaux',
    'nouvelles',
    'inscrire',
    'register',
  ],
  edit: ['edit', 'modify', 'update', 'change', 'modifier', 'editer', 'mettre a jour', 'changer'],
  delete: [...(RISK_KEYWORDS.delete ?? [])],
  save: ['save', 'submit', 'apply', 'enregistrer', 'sauvegarder', 'soumettre', 'appliquer', 'valider'],
  cancel: ['cancel', 'annuler', 'abandonner', 'discard'],
  confirm: ['confirm', 'ok', 'yes', 'confirmer', 'oui', 'accepter', 'accept'],
  close: ['close', 'dismiss', 'fermer'],
  next: ['next', 'next step', 'continue', 'suivant', 'etape suivante', 'continuer'],
  previous: ['previous', 'prev', 'back', 'precedent', 'etape precedente', 'retour'],
  home: ['home', 'dashboard', 'accueil', 'tableau de bord'],
  retry: ['retry', 'try again', 'reload', 'reessayer', 'recharger'],
  search: [...SEARCH_KEYWORDS],
  filter: [...FILTER_KEYWORDS],
  view: [...DETAILS_KEYWORDS],
  export: [...EXPORT_KEYWORDS],
  upload: [
    'upload',
    'import',
    'attach',
    'televerser',
    'importer',
    'joindre',
    'deposer',
    'parcourir',
    'browse',
  ],
  login: ['login', 'log in', 'sign in', 'signin', 'connexion', 'se connecter', 'identifiant', 'mot de passe'],
  logout: [...(RISK_KEYWORDS.logout ?? [])],
  settings: ['settings', 'preferences', 'configuration', 'parametres', 'reglages'],
} as const satisfies Record<string, readonly string[]>;

export type BuiltinConcept = keyof typeof BUILTIN_CONCEPTS;

export interface SemanticsInput {
  /** Mots ajoutés aux concepts (ou nouveaux concepts) : `create: [enrôler]`. */
  concepts?: Readonly<Record<string, readonly string[]>>;
  /** Synonymes d'un terme de mission : `users: [utilisateur, membres]`. */
  synonyms?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Le vocabulaire du moteur, en un seul endroit : concepts (create, delete, save…)
 * et synonymes des termes de la mission. Utilisé par le PatternDetector, le
 * GoalMatcher, l'ActionScorer et la SafetyPolicy (qui ne peut qu'y ajouter des mots
 * à bloquer, jamais en retirer).
 *
 * Pas de NLP : minuscules, sans accents, espaces réduits, et un pluriel simple
 * (« utilisateurs » ≈ « utilisateur », « users » ≈ « user »).
 */
export class SemanticDictionary {
  private readonly concepts = new Map<string, string[]>();
  private readonly synonyms = new Map<string, string[]>();
  private readonly matchers = new Map<string, KeywordMatcher>();

  constructor(...inputs: (SemanticsInput | undefined)[]) {
    for (const [concept, words] of Object.entries(BUILTIN_CONCEPTS)) this.concepts.set(concept, [...words]);
    for (const input of inputs) {
      for (const [concept, words] of Object.entries(input?.concepts ?? {}))
        this.concepts.set(concept, unique([...(this.concepts.get(concept) ?? []), ...words]));
      for (const [term, words] of Object.entries(input?.synonyms ?? {})) {
        const key = semanticKey(term);
        this.synonyms.set(key, unique([...(this.synonyms.get(key) ?? []), term, ...words]));
      }
    }
  }

  /** Les mots d'un concept (vide pour un concept inconnu). */
  wordsOf(concept: string): string[] {
    return [...(this.concepts.get(concept) ?? [])];
  }

  /**
   * Les mots qu'une mission ou un pack a ajoutés à un concept (pas les mots intégrés).
   * La SafetyPolicy ne reprend que ceux-là, et seulement pour bloquer davantage.
   */
  addedWords(concept: string): string[] {
    const builtin = new Set<string>((BUILTIN_CONCEPTS as Record<string, readonly string[]>)[concept] ?? []);
    return this.wordsOf(concept).filter((word) => !builtin.has(word));
  }

  conceptNames(): string[] {
    return [...this.concepts.keys()];
  }

  /** Le mot du concept trouvé dans l'un des textes (mots entiers), ou undefined. */
  match(concept: string, ...texts: (string | undefined)[]): string | undefined {
    let matcher = this.matchers.get(concept);
    if (!matcher) {
      matcher = new KeywordMatcher(this.wordsOf(concept));
      this.matchers.set(concept, matcher);
    }
    return matcher.match(...texts);
  }

  /** Tous les concepts présents dans les textes, dans l'ordre des concepts. */
  conceptsIn(...texts: (string | undefined)[]): string[] {
    return this.conceptNames().filter((concept) => this.match(concept, ...texts) !== undefined);
  }

  /**
   * Les formes d'un terme de mission : lui-même, ses synonymes configurés, et les mots
   * qui le composent (« create-user » → create-user, create user, et les mots du
   * concept create + « user »).
   */
  expand(term: string): string[] {
    const key = semanticKey(term);
    const words = [term, key, ...(this.synonyms.get(key) ?? [])];
    return unique(words.map((word) => normalizeText(word)).filter(Boolean));
  }

  /** Vrai quand un terme de mission apparaît dans un texte (synonymes et pluriels simples compris). */
  mentions(term: string, text: string | undefined): boolean {
    if (!text) return false;
    const haystack = ` ${singularWords(text)} `;
    return this.expand(term).some((form) => haystack.includes(` ${singularWords(form)} `));
  }
}

/** « Create-User » → « create user » : la clé d'un terme de mission. */
export function semanticKey(term: string): string {
  return normalizeText(term.replace(/[-_/.]+/g, ' '));
}

/** Chaque mot ramené au singulier simple (s, x final), après normalisation. */
export function singularWords(text: string): string {
  return normalizeText(text.replace(/[-_/.:]+/g, ' '))
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(singular)
    .join(' ');
}

function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/[^s]s$/.test(word) || /[aeiou]x$/.test(word)) return word.slice(0, -1);
  return word;
}

function unique(words: readonly string[]): string[] {
  return [...new Set(words)];
}
