import { filter } from 'rxjs';
import { NamedAction } from './c06.api';

export const isSave = (action: NamedAction): boolean => action.type === 'SAVE';

export function onAction(type: NamedAction['type']) {
  return filter((action: NamedAction) => action.type === type);
}
