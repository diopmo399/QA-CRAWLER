import { Injectable } from '@angular/core';
import { Observable, Subject, map } from 'rxjs';
import { OrderAction } from './actions';
import { OrderApi } from './order-api.service';
import { OrderStore } from './order.store';

/** Valide puis enchaîne : directement (A), par un Subject (B), ou en échec (G). */
@Injectable({ providedIn: 'root' })
export class ValidationStore {
  private readonly result = new Subject<{ valid: boolean; form: unknown }>();
  readonly result$ = this.result.asObservable();

  constructor(
    private api: OrderApi,
    private orders: OrderStore,
  ) {}

  validate(form: unknown): Observable<boolean> {
    return this.api.validate(form).pipe(map((r) => r.valid));
  }

  /** A + G : la validation échouée arrête le parcours ; sinon le résultat devient le payload du dispatch. */
  validateThenSubmit(form: unknown): void {
    this.validate(form).subscribe((valid) => {
      if (!valid) {
        return;
      }
      const payload = { form, valid };
      this.orders.dispatch(OrderAction.Submit, payload);
    });
  }

  /** B : le résultat est publié ; un autre store le consomme. */
  publish(form: unknown): void {
    this.api.validate(form).subscribe((r) => this.result.next({ valid: r.valid, form }));
  }
}
