export const VALIDER = 'VALIDER';
export const ENREGISTRER = 'ENREGISTRER';

export interface Action {
  type: string;
  payload?: unknown;
}

/** Fabrique d'action : son nom n'a aucune importance pour l'analyse. */
export function createAction(type: string, payload: unknown): Action {
  return { type, payload };
}

export const makeValidationAction = (data: unknown): Action => ({ type: VALIDER, payload: data });

/** Une fabrique générique qui en appelle une autre. */
export const makeSaveAction = <T>(data: T): Action => createAction(ENREGISTRER, data);

/** Deux retours possibles : l'action n'est pas déterminable statiquement. */
export function pickAction(flag: boolean, data: unknown): Action {
  if (flag) return createAction(VALIDER, data);
  return createAction(ENREGISTRER, data);
}

/** Une fonction qui rend un objet sans être une fabrique d'action : elle n'est jamais suivie pour rien. */
export function toLabel(value: string): { text: string } {
  return { text: value };
}
