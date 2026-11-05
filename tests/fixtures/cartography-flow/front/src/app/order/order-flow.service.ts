import { Injectable } from '@angular/core';
import { Subject, filter, forkJoin, switchMap, takeUntil } from 'rxjs';
import { OrderAction } from './actions';
import { OrderApi } from './order-api.service';
import { OrderStore } from './order.store';
import { ValidationStore } from './validation.store';

/** D : un service qui orchestre plusieurs stores. */
@Injectable({ providedIn: 'root' })
export class OrderFlow {
  private readonly destroy = new Subject<void>();
  private readonly query = new Subject<string>();
  readonly results$ = this.query.pipe(
    switchMap((q) => this.api.search(q)),
    takeUntil(this.destroy),
  );

  constructor(
    private api: OrderApi,
    private orders: OrderStore,
    private validation: ValidationStore,
  ) {
    // B : le résultat publié par ValidationStore déclenche un dispatch ici.
    this.validation.result$.pipe(filter((r) => r.valid)).subscribe((r) => {
      this.orders.dispatch(OrderAction.Submit, r.form);
    });
  }

  /** E : deux validations combinées avant le dispatch. */
  submitChecked(form: unknown): void {
    forkJoin([this.validation.validate(form), this.api.check()]).subscribe(([valid, allowed]) => {
      if (valid && allowed) this.orders.dispatch(OrderAction.Submit, form);
    });
  }

  search(q: string): void {
    this.query.next(q);
  }
}
