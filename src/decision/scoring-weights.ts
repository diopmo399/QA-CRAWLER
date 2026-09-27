/**
 * Tous les nombres qu'utilise le score des actions, au même endroit. La mission
 * peut surcharger chacun d'eux (`scoring.weights` dans le YAML) ; rien d'autre
 * dans le code n'impose une priorité en dur.
 *
 * Les poids positifs rendent une action plus attirante, les négatifs moins.
 * Ce qui ne doit jamais s'exécuter (suppression, paiement, navigation externe…)
 * n'est pas un poids : la SafetyPolicy le bloque et le scorer l'exclut.
 */
export const DEFAULT_SCORING_WEIGHTS = {
  // ---- ce que l'action peut apporter
  /** Mène à un état jamais vu : un lien vers une nouvelle route, un onglet jamais ouvert, une étape d'assistant. */
  newState: 100,
  /** Pas encore exécutée depuis cet état (toutes les candidates : les autres sont exclues). */
  neverExecuted: 80,
  /** Fait avancer un formulaire (étape d'assistant) ou change l'un de ses choix. */
  formNeverExplored: 70,
  /** Lien dans le contenu de la page. */
  internalNavigation: 60,
  tab: 50,
  details: 40,
  search: 30,
  filter: 20,
  pagination: 10,
  /** Bouton qui ouvre un menu ou un panneau. */
  menu: 45,
  /** Contrôle afficher/masquer (accordéon, « plus »…). */
  toggle: 25,
  /** Tout autre contrôle sûr de la page. */
  other: 15,
  /** Entrée du menu global (zone de navigation) : la page elle-même d'abord. */
  globalMenu: 20,

  // ---- ce que cherche la mission (goals.keywords)
  /** Le libellé de l'action contient un mot-clé d'objectif (« Utilisateurs »). */
  goalText: 100,
  /** Seule son URL cible contient un mot-clé d'objectif (/admin/users). */
  goalUrl: 80,

  // ---- ce qui la rend moins intéressante
  /** Le même contrôle a déjà été utilisé depuis un autre état. */
  alreadyExplored: -100,
  /** Sa route cible a déjà des états connus. */
  targetWellExplored: -40,
  /** Exporter, télécharger, imprimer : des fichiers, pas des écrans. */
  export: -30,
  /** Déconnexion (bloquée de toute façon par la SafetyPolicy). */
  logout: -100,
  /** Déjà connue par la baseline (mode explore) : le nouveau terrain d'abord, sans l'ignorer. */
  knownInBaseline: -50,

  // ---- ce qui est devant l'utilisateur
  /** Dans la fenêtre, le tiroir ou le menu ouvert devant l'écran. */
  foreground: 200,
} as const;

export type ScoringWeightName = keyof typeof DEFAULT_SCORING_WEIGHTS;
export type ScoringWeights = Record<ScoringWeightName, number>;

export const SCORING_WEIGHT_NAMES = Object.keys(DEFAULT_SCORING_WEIGHTS) as ScoringWeightName[];

/** Valeurs par défaut, avec les surcharges de la mission. */
export function scoringWeights(overrides: Partial<Record<ScoringWeightName, number>> = {}): ScoringWeights {
  return { ...DEFAULT_SCORING_WEIGHTS, ...overrides };
}
