/** Motifs d'interface reconnus sur un écran. Un écran peut en montrer plusieurs (CRUD_LIST + SEARCH + PAGINATION). */
export const UI_PATTERNS = [
  'LOGIN',
  'CRUD_LIST',
  'CREATE_FORM',
  'EDIT_FORM',
  'DETAIL',
  'SEARCH',
  'FILTER',
  'PAGINATION',
  'WIZARD',
  'CONFIRMATION_DIALOG',
  'ERROR_PAGE',
  'EMPTY_STATE',
  'DASHBOARD',
  'MASTER_DETAIL',
  'TABS',
  'MENU',
  'UPLOAD',
] as const;
export type UiPattern = (typeof UI_PATTERNS)[number];

export interface DetectedPattern {
  type: UiPattern;
  /** 0..1 : grandit avec le nombre de signaux indépendants observés. */
  confidence: number;
  /** Les signaux observés, lisibles (« table with 12 rows », « button "Ajouter" (create) »). */
  evidence: string[];
}
