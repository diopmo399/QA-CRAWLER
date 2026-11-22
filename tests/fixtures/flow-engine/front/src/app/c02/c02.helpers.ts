import { IndirectAction } from './c02.api';
import { IndirectStore } from './c02.store';

export function emitOn(store: IndirectStore, action: IndirectAction): void {
  store.dispatch(action);
}
