import { Injectable } from '@angular/core';
import { Subject, debounceTime, filter, map, switchMap, tap } from 'rxjs';
import { MappedAction, MappedApi } from './c05.api';

@Injectable({ providedIn: 'root' })
export class MappedStore {
  private readonly actions = new Subject<MappedAction>();
  // Le map garde l'action (spread) : le filter qui suit porte toujours sur le type émis.
  readonly saved$ = this.actions.pipe(
    debounceTime(10),
    map((a) => ({ ...a, at: 1 })),
    filter((a) => a.type === 'SAVE'),
    switchMap(() => this.api.save()),
  );
  // Un effet qui en déclenche un autre : après le chargement, une action REJECT repart dans le flux.
  readonly loaded$ = this.actions.pipe(
    tap(() => undefined),
    filter((a) => a.type === 'LOAD'),
    switchMap(() => this.api.list()),
    tap(() => this.actions.next({ type: 'REJECT' })),
  );
  readonly rejected$ = this.actions.pipe(
    filter((a) => a.type === 'REJECT'),
    switchMap(() => this.api.remove()),
  );

  constructor(private api: MappedApi) {}

  dispatch(action: MappedAction): void {
    this.actions.next(action);
  }
}
