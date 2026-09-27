import type { RiskKind } from '../model/discovered-action.js';

/**
 * Vocabulaire intégré (français + anglais). Les mots-clés sont comparés comme des
 * mots ou expressions entiers, sur du texte en minuscules sans accents : « add » ne
 * correspond pas à « address » et « pay » ne correspond pas à « paysage ».
 */

/** Intentions risquées, par genre. Toute correspondance rend une action DANGEROUS. */
export const RISK_KEYWORDS: Partial<Record<RiskKind, readonly string[]>> = {
  delete: [
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
  ],
  payment: [
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
    'regler',
  ],
  send: [
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
  ],
  logout: ['logout', 'log out', 'sign out', 'signout', 'deconnexion', 'se deconnecter', 'deconnecter'],
  irreversible: [
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
  ],
};

/** Modifications de données. */
export const MUTATION_KEYWORDS = [
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
  'mark',
  'rate',
  'vote',
  'like',
  'comment',
  'reply',
  'yes',
  'ok',
  'agree',
  'creer',
  'ajouter',
  'nouveau',
  'nouvelle',
  'nouvel',
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
  'terminer',
  'oui',
] as const;

/** Passer d'une étape d'assistant à l'autre (côté client, aucune donnée envoyée). */
/** Boutons qui envoient le formulaire auquel ils appartiennent (dans un <form>, une fenêtre ou un calque avec des champs). */
export const SUBMIT_KEYWORDS = [
  'submit',
  'save',
  'send',
  'confirm',
  'validate',
  'create',
  'add',
  'finish',
  'publish',
  'register',
  'ok',
  'soumettre',
  'enregistrer',
  'sauvegarder',
  'envoyer',
  'transmettre',
  'confirmer',
  'valider',
  'creer',
  'ajouter',
  'terminer',
  'publier',
] as const;

/** Des fichiers plutôt que des écrans : explorés en dernier. */
export const EXPORT_KEYWORDS = [
  'export',
  'exporter',
  'download',
  'telecharger',
  'print',
  'imprimer',
  'csv',
  'excel',
  'pdf',
] as const;

export const STEP_KEYWORDS = [
  'next',
  'next step',
  'continue',
  'previous',
  'back',
  'suivant',
  'etape suivante',
  'continuer',
  'precedent',
  'etape precedente',
  'retour',
] as const;

export const PAGINATION_KEYWORDS = [
  'next',
  'previous',
  'prev',
  'page',
  'first',
  'last',
  'load more',
  'more',
  'suivant',
  'precedent',
  'premiere',
  'derniere',
  'charger plus',
  'voir plus',
  'plus',
] as const;

export const DETAILS_KEYWORDS = [
  'details',
  'detail',
  'view',
  'show',
  'open',
  'see',
  'preview',
  'expand',
  'more info',
  'voir',
  'afficher',
  'ouvrir',
  'consulter',
  'apercu',
  'deplier',
  'en savoir plus',
  'fiche',
] as const;

export const SEARCH_KEYWORDS = ['search', 'find', 'rechercher', 'recherche', 'chercher', 'trouver'] as const;

export const FILTER_KEYWORDS = [
  'filter',
  'filters',
  'sort',
  'order by',
  'group by',
  'refresh',
  'filtre',
  'filtres',
  'filtrer',
  'trier',
  'tri',
  'actualiser',
  'rafraichir',
] as const;

/** Champs qui ne doivent jamais être remplis automatiquement. */
export const SENSITIVE_FIELD_KEYWORDS = [
  'password',
  'passwd',
  'mot de passe',
  'mdp',
  'pin',
  'otp',
  'one time code',
  'secret',
  'token',
  'api key',
  'card',
  'card number',
  'credit card',
  'carte',
  'carte bancaire',
  'cb',
  'cvv',
  'cvc',
  'cryptogramme',
  'expiry',
  'expiration',
  'iban',
  'bic',
  'swift',
  'rib',
  'ssn',
  'social security',
  'securite sociale',
  'nir',
  'passport',
  'passeport',
  'authorization',
  'bearer',
  'apikey',
  'access key',
  'private key',
  'client secret',
  'credential',
  'credentials',
  'bank account',
  'account number',
  'compte bancaire',
  'numero de compte',
  'sin',
  'social insurance',
  'nas',
  'assurance sociale',
] as const;

/** Champs de paiement : jamais remplis, pas même avec une valeur de l'environnement. */
export const PAYMENT_FIELD_KEYWORDS = [
  'card',
  'card number',
  'credit card',
  'carte',
  'carte bancaire',
  'cb',
  'cvv',
  'cvc',
  'cryptogramme',
  'expiry',
  'expiration',
  'iban',
  'bic',
  'swift',
  'rib',
  'bank account',
  'account number',
  'compte bancaire',
  'numero de compte',
] as const;

/** Minuscules, sans accents, camelCase séparé : « Supprimer l'élément » → « supprimer l'element », « deleteUser » → « delete user ». */
export function normalizeText(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recherche par mots entiers ; le mot-clé le plus long l'emporte (« confirmer paiement » bat « confirmer »). */
export class KeywordMatcher {
  private readonly patterns: { keyword: string; regex: RegExp }[];

  constructor(keywords: readonly string[]) {
    this.patterns = [...new Set(keywords.map((keyword) => normalizeText(keyword)).filter(Boolean))]
      .sort((a, b) => b.length - a.length)
      .map((keyword) => ({
        keyword,
        regex: new RegExp(`(^|[^a-z0-9])${escapeRegex(keyword).replace(/ /g, '[^a-z0-9]+')}($|[^a-z0-9])`),
      }));
  }

  match(...texts: (string | undefined)[]): string | undefined {
    for (const text of texts) {
      if (!text) continue;
      const normalized = normalizeText(text);
      if (normalized === '') continue;
      const found = this.patterns.find(({ regex }) => regex.test(normalized));
      if (found) return found.keyword;
    }
    return undefined;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Chemin et hash d'une URL, décodés, pour la recherche de mots-clés (« /users/3/delete »). */
export function urlText(href: string): string {
  try {
    const url = new URL(href, 'http://placeholder.invalid');
    return decodeURIComponent(`${url.pathname} ${url.hash}`).replace(/[/#?=&]+/g, ' ');
  } catch {
    return href;
  }
}
