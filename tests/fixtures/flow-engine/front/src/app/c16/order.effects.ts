import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { exhaustMap, map, mergeMap, switchMap, tap } from 'rxjs';
import * as OrderActions from './order.actions';
import { OrderPageActions, loadOrders, saveOrder } from './order.actions';
import { OrderApi } from './order.api';

@Injectable()
export class OrderEffects {
  private readonly actions$ = inject(Actions);
  private readonly api = inject(OrderApi);

  // Un créateur importé par espace de noms ; l'action de succès repart dans le store.
  readonly load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(OrderActions.loadOrders),
      switchMap(() => this.api.list().pipe(map((items) => OrderActions.loadOrdersSuccess({ items })))),
    ),
  );

  // Un effet qui en relance un autre : après l'enregistrement, la liste est rechargée.
  readonly save$ = createEffect(() =>
    this.actions$.pipe(
      ofType(saveOrder),
      exhaustMap(() => this.api.save()),
      map(() => loadOrders()),
    ),
  );

  // Un membre d'un groupe d'actions.
  readonly remove$ = createEffect(() =>
    this.actions$.pipe(
      ofType(OrderPageActions.removeOrder),
      mergeMap(() => this.api.remove()),
      map(() => OrderPageActions.orderRemoved()),
    ),
  );

  // Un effet sans action rendue.
  readonly audit$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(OrderPageActions.orderRemoved),
        tap(() => this.api.audit().subscribe()),
      ),
    { dispatch: false },
  );
}
