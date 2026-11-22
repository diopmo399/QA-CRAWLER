import { Injectable } from '@angular/core';
import { Subject, filter, map, switchMap, withLatestFrom } from 'rxjs';
import { ShapeAction, ShapeApi } from './c09.api';

@Injectable({ providedIn: 'root' })
export class ShapeStore {
  private readonly actions = new Subject<ShapeAction>();
  private readonly ticks = new Subject<number>();
  // Le map réécrit le type : quelle que soit l'action émise, le filter sur LOAD ne passe jamais.
  readonly forced$ = this.actions.pipe(
    map((a) => ({ ...a, type: 'REJECT' as const })),
    filter((a) => a.type === 'LOAD'),
    switchMap(() => this.api.list()),
  );
  // Le map perd l'objet : le type n'est plus lisible, toute émission reste une candidate (rien n'est écarté).
  readonly opaque$ = this.actions.pipe(
    map((a) => JSON.stringify(a)),
    filter((text) => text.length > 0),
    switchMap(() => this.api.remove()),
  );
  // Après withLatestFrom, le rappel reçoit un tableau : son premier élément est l'action émise.
  readonly paired$ = this.actions.pipe(
    withLatestFrom(this.ticks),
    filter(([a]) => a.type === 'SAVE'),
    switchMap(() => this.api.save()),
  );

  constructor(private api: ShapeApi) {}

  dispatch(action: ShapeAction): void {
    this.actions.next(action);
  }
}
