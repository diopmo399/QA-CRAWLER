/**
 * INTENTION D'UNE ÉTAPE GHERKIN : ce que le scénario demande, jamais comment l'exécuter.
 * Aucun sélecteur, aucun localisateur Playwright : « je renseigne le prénom avec
 * "Mohamed" » devient { kind: FILL, field: "prénom", value: "Mohamed" }. Le
 * SemanticResolver trouve ensuite la cible à l'écran ; l'exécution reste celle des flows
 * (SafetyPolicy comprise).
 */

/** Une valeur du scénario : littérale, ou lue dans une variable d'environnement (`<env:NOM>`). */
export type IntentValue = string | { env: string } | { testData: string };

export interface NavigateIntent {
  kind: 'NAVIGATE';
  /** « utilisateurs », « paramètres », « gestion des rôles ». */
  target: string;
  /** « Étant donné que je suis sur la page … » : déjà là ? Rien à faire. */
  precondition?: boolean;
}

export interface ClickIntent {
  kind: 'CLICK';
  target: string;
  /** Rôle suggéré par la phrase (« le bouton », « l'onglet »). */
  role?: string;
}

export interface FillIntent {
  kind: 'FILL';
  field: string;
  value: IntentValue;
}

export interface SelectIntent {
  kind: 'SELECT';
  field: string;
  option: string;
}

export interface CheckIntent {
  kind: 'CHECK';
  field: string;
  checked: boolean;
}

export interface UploadIntent {
  kind: 'UPLOAD';
  field: string;
  file: string;
}

/** Valider, annuler, suivant, précédent : l'action d'un formulaire, trouvée par son rôle. */
export interface SubmitIntent {
  kind: 'SUBMIT';
  action: 'submit' | 'cancel' | 'next' | 'previous';
  /** Le verbe du scénario (« valide », « enregistre ») : départage des boutons proches. */
  verb?: string;
}

export interface FillFormIntent {
  kind: 'FILL_FORM';
  /** « utilisateur » dans « je remplis le formulaire utilisateur ». */
  form?: string;
  /** Sans lignes : les données synthétiques du TestDataProvider. */
  rows?: { field: string; value: IntentValue }[];
}

export const ASSERTION_KINDS = ['PAGE_DISPLAYED', 'MESSAGE', 'ENTITY_VISIBLE', 'ENTITY_CREATED'] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export interface AssertionIntent {
  kind: 'ASSERT';
  assertion: AssertionKind;
  /** La page, l'entité (« l'utilisateur ») ou le texte attendu. */
  subject?: string;
  /** MESSAGE : quel genre de message. */
  message?: 'confirmation' | 'error' | 'any';
}

export type GherkinIntent =
  | NavigateIntent
  | ClickIntent
  | FillIntent
  | SelectIntent
  | CheckIntent
  | UploadIntent
  | SubmitIntent
  | FillFormIntent
  | AssertionIntent;

export type IntentKind = GherkinIntent['kind'];

/** Une intention en une ligne, sans valeur (les valeurs peuvent être sensibles). */
export function describeIntent(intent: GherkinIntent): string {
  switch (intent.kind) {
    case 'NAVIGATE':
      return `NAVIGATE "${intent.target}"${intent.precondition ? ' (precondition)' : ''}`;
    case 'CLICK':
      return `CLICK "${intent.target}"${intent.role ? ` (${intent.role})` : ''}`;
    case 'FILL':
      return `FILL "${intent.field}"`;
    case 'SELECT':
      return `SELECT "${intent.option}" as "${intent.field}"`;
    case 'CHECK':
      return `${intent.checked ? 'CHECK' : 'UNCHECK'} "${intent.field}"`;
    case 'UPLOAD':
      return `UPLOAD into "${intent.field}"`;
    case 'SUBMIT':
      return `${intent.action.toUpperCase()}${intent.verb ? ` (${intent.verb})` : ''}`;
    case 'FILL_FORM':
      return `FILL_FORM${intent.form ? ` "${intent.form}"` : ''}${intent.rows ? ` (${intent.rows.length} field(s))` : ' (synthetic data)'}`;
    case 'ASSERT':
      return `ASSERT ${intent.assertion}${intent.subject ? ` "${intent.subject}"` : ''}${intent.message ? ` (${intent.message})` : ''}`;
  }
}
