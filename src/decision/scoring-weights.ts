/**
 * Every number the action scoring uses, in one place. The mission can
 * override any of them (`scoring.weights` in the YAML); nothing else in the
 * code hard-codes a priority.
 *
 * Positive weights make an action more attractive, negative ones less.
 * What must never run (delete, payment, external navigation…) is not a
 * weight: the SafetyPolicy blocks it and the scorer excludes it.
 */
export const DEFAULT_SCORING_WEIGHTS = {
  // ---- what the action may bring
  /** Leads to a state never seen: a link to a new route, a tab never opened, a wizard step. */
  newState: 100,
  /** Not executed yet from this state (every candidate: others are excluded). */
  neverExecuted: 80,
  /** Moves a form forward (wizard step) or changes one of its choices. */
  formNeverExplored: 70,
  /** Link inside the page content. */
  internalNavigation: 60,
  tab: 50,
  details: 40,
  search: 30,
  filter: 20,
  pagination: 10,
  /** Button opening a menu or a panel. */
  menu: 45,
  /** Show/hide control (accordion, "more"…). */
  toggle: 25,
  /** Any other safe in-page control. */
  other: 15,
  /** Entry of the global menu (navigation landmark): the page itself first. */
  globalMenu: 20,

  // ---- what the mission is after (goals.keywords)
  /** The label of the action matches a goal keyword ("Utilisateurs"). */
  goalText: 100,
  /** Only its target URL matches a goal keyword (/admin/users). */
  goalUrl: 80,

  // ---- what makes it less interesting
  /** The same control was already used from another state. */
  alreadyExplored: -100,
  /** Its target route already has known states. */
  targetWellExplored: -40,
  /** Export, download, print: files, not screens. */
  export: -30,
  /** Logout (blocked by the SafetyPolicy anyway). */
  logout: -100,
  /** Already known from the baseline (explore mode): new ground first, without ignoring it. */
  knownInBaseline: -50,

  // ---- what is in front of the user
  /** Inside the dialog, drawer or open menu in front of the screen. */
  foreground: 200,
} as const;

export type ScoringWeightName = keyof typeof DEFAULT_SCORING_WEIGHTS;
export type ScoringWeights = Record<ScoringWeightName, number>;

export const SCORING_WEIGHT_NAMES = Object.keys(DEFAULT_SCORING_WEIGHTS) as ScoringWeightName[];

/** Defaults, with the mission's overrides. */
export function scoringWeights(overrides: Partial<Record<ScoringWeightName, number>> = {}): ScoringWeights {
  return { ...DEFAULT_SCORING_WEIGHTS, ...overrides };
}
