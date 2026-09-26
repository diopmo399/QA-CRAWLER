import type { ScenarioConfig } from '../config/config.js';
import type { ActionClassification, DiscoveredAction, RawAction } from '../model/discovered-action.js';

/**
 * Built-in vocabulary (French + English). Keywords are matched as whole
 * words/phrases on accent-free lower-case text, so "add" does not match
 * "address" and "pay" does not match "paysage".
 */
const DANGEROUS_KEYWORDS = [
  // destructive
  'delete',
  'remove',
  'destroy',
  'erase',
  'purge',
  'drop',
  'wipe',
  'truncate',
  'trash',
  'supprimer',
  'suppression',
  'effacer',
  'detruire',
  'vider',
  'retirer',
  'corbeille',
  // payments / money
  'pay',
  'payer',
  'payment',
  'paiement',
  'checkout',
  'purchase',
  'buy',
  'acheter',
  'place order',
  'passer commande',
  'commander',
  'confirmer paiement',
  'confirm payment',
  'refund',
  'rembourser',
  'transfer',
  'virement',
  'donate',
  'faire un don',
  // communication with real people
  'send',
  'envoyer',
  'send email',
  'envoyer email',
  'send message',
  'envoyer message',
  'notify',
  'notifier',
  'broadcast',
  'diffuser',
  'invite',
  'inviter',
  // irreversible / account-level
  'revoke',
  'revoquer',
  'deactivate',
  'desactiver',
  'disable',
  'suspend',
  'suspendre',
  'ban',
  'bannir',
  'reset',
  'reinitialiser',
  'terminate',
  'resilier',
  'close account',
  'fermer le compte',
  'irreversible',
  'archive',
  'archiver',
  'cancel subscription',
  'unsubscribe',
  'desabonner',
  // session
  'logout',
  'log out',
  'sign out',
  'signout',
  'deconnexion',
  'se deconnecter',
  'deconnecter',
] as const;

const MUTATION_KEYWORDS = [
  'create',
  'add',
  'new',
  'save',
  'edit',
  'update',
  'modify',
  'submit',
  'publish',
  'upload',
  'import',
  'register',
  'sign up',
  'signup',
  'approve',
  'reject',
  'accept',
  'decline',
  'assign',
  'duplicate',
  'copy',
  'clone',
  'rename',
  'move',
  'apply',
  'confirm',
  'validate',
  'enable',
  'activate',
  'reserve',
  'cancel',
  'restore',
  'generate',
  'sync',
  'toggle',
  'mark',
  'rate',
  'vote',
  'like',
  'comment',
  'reply',
  'creer',
  'ajouter',
  'nouveau',
  'nouvelle',
  'enregistrer',
  'sauvegarder',
  'modifier',
  'editer',
  'mettre a jour',
  'soumettre',
  'publier',
  'televerser',
  'importer',
  'inscrire',
  'inscription',
  "s'inscrire",
  'approuver',
  'refuser',
  'rejeter',
  'accepter',
  'affecter',
  'assigner',
  'dupliquer',
  'copier',
  'renommer',
  'deplacer',
  'appliquer',
  'confirmer',
  'valider',
  'activer',
  'reserver',
  'annuler',
  'restaurer',
  'generer',
  'synchroniser',
  'marquer',
  'noter',
  'voter',
  'commenter',
  'repondre',
  'postuler',
] as const;

const SAFE_KEYWORDS = [
  'next',
  'previous',
  'prev',
  'page',
  'first',
  'last',
  'more',
  'show',
  'view',
  'details',
  'detail',
  'open',
  'close',
  'expand',
  'collapse',
  'tab',
  'filter',
  'filters',
  'search',
  'sort',
  'refresh',
  'back',
  'home',
  'menu',
  'help',
  'zoom',
  'print',
  'preview',
  'toggle menu',
  'navigation',
  'load more',
  'see more',
  'read more',
  'suivant',
  'precedent',
  'premiere',
  'derniere',
  'plus',
  'afficher',
  'voir',
  'details',
  'ouvrir',
  'fermer',
  'deplier',
  'replier',
  'onglet',
  'filtre',
  'filtrer',
  'rechercher',
  'recherche',
  'trier',
  'actualiser',
  'rafraichir',
  'retour',
  'accueil',
  'aide',
  'apercu',
  'imprimer',
  'voir plus',
  'lire la suite',
  'charger plus',
] as const;

export interface Classification {
  classification: ActionClassification;
  reason: string;
}

/**
 * Central safety rules. Decides how risky an action is and whether the
 * crawler may trigger it. By default only SAFE actions are executable;
 * MUTATION, DANGEROUS and UNKNOWN actions are recorded but never executed.
 */
export class SafetyPolicy {
  private readonly dangerous: KeywordMatcher;
  private readonly mutation: KeywordMatcher;
  private readonly safe: KeywordMatcher;
  private readonly allowed: ReadonlySet<ActionClassification>;

  constructor(safety: Pick<ScenarioConfig['safety'], 'allowedActionClasses' | 'keywords'>) {
    this.dangerous = new KeywordMatcher([...DANGEROUS_KEYWORDS, ...safety.keywords.dangerous]);
    this.mutation = new KeywordMatcher([...MUTATION_KEYWORDS, ...safety.keywords.mutation]);
    this.safe = new KeywordMatcher([...SAFE_KEYWORDS, ...safety.keywords.safe]);
    this.allowed = new Set(safety.allowedActionClasses);
  }

  classify(action: RawAction): Classification {
    const label = [action.text, action.name, action.elementId].filter(Boolean).join(' ');
    const target = [action.href ? pathOf(action.href) : '', action.routerLink ?? ''].join(' ');

    const dangerous = this.dangerous.match(label) ?? this.dangerous.match(target);
    if (dangerous) return { classification: 'DANGEROUS', reason: `matches dangerous keyword "${dangerous}"` };

    const mutation = this.mutation.match(label) ?? this.mutation.match(target);

    switch (action.type) {
      case 'link':
      case 'router-link':
        if (mutation) return { classification: 'MUTATION', reason: `navigation to a "${mutation}" screen` };
        return { classification: 'SAFE', reason: 'navigation link' };

      case 'button': {
        if (action.isSubmit && !action.inSearchForm) {
          return { classification: 'MUTATION', reason: 'submits a form' };
        }
        if (mutation) return { classification: 'MUTATION', reason: `matches mutation keyword "${mutation}"` };
        if (action.isSubmit && action.inSearchForm)
          return { classification: 'SAFE', reason: 'submits a search form' };
        const safe = this.safe.match(label);
        if (safe) return { classification: 'SAFE', reason: `matches safe keyword "${safe}"` };
        return { classification: 'UNKNOWN', reason: 'unrecognised button (never executed automatically)' };
      }

      case 'input':
      case 'select':
      case 'textarea':
        if (action.inputType === 'search' || action.inSearchForm) {
          return { classification: 'SAFE', reason: 'search/filter field' };
        }
        if (action.type === 'select' && this.safe.match(label)) {
          return { classification: 'SAFE', reason: 'filter/sort selector' };
        }
        return { classification: 'MUTATION', reason: 'data entry field' };
    }
  }

  /** Classifies a URL the crawler is about to navigate to (e.g. /users/3/delete). */
  classifyUrl(url: string): Classification {
    const path = pathOf(url);
    const dangerous = this.dangerous.match(path);
    if (dangerous)
      return { classification: 'DANGEROUS', reason: `URL matches dangerous keyword "${dangerous}"` };
    return { classification: 'SAFE', reason: 'plain navigation' };
  }

  withClassification(action: RawAction): DiscoveredAction {
    return { ...action, ...this.classify(action) };
  }

  /** Whether the crawler may trigger an action of this class automatically. */
  isExecutionAllowed(classification: ActionClassification): boolean {
    return this.allowed.has(classification);
  }
}

class KeywordMatcher {
  private readonly patterns: { keyword: string; regex: RegExp }[];

  constructor(keywords: readonly string[]) {
    this.patterns = [...new Set(keywords.map((keyword) => normalizeText(keyword)).filter(Boolean))]
      // longest first so "confirmer paiement" wins over "confirmer"
      .sort((a, b) => b.length - a.length)
      .map((keyword) => ({
        keyword,
        regex: new RegExp(`(^|[^a-z0-9])${escapeRegex(keyword).replace(/ /g, '[^a-z0-9]+')}($|[^a-z0-9])`),
      }));
  }

  match(text: string): string | undefined {
    const normalized = normalizeText(text);
    if (normalized === '') return undefined;
    return this.patterns.find(({ regex }) => regex.test(normalized))?.keyword;
  }
}

/** Lower-case, accent-free, camelCase split: "Supprimer l'élément" → "supprimer l'element", "deleteUser" → "delete user". */
export function normalizeText(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathOf(href: string): string {
  try {
    const url = new URL(href, 'http://placeholder.invalid');
    return decodeURIComponent(`${url.pathname} ${url.hash}`);
  } catch {
    return href;
  }
}
