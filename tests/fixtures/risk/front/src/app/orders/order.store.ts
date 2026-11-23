import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, filter, switchMap } from 'rxjs';
import { ApiService, Order } from '../api.service';

export interface OrderAction {
  type: 'SAVE' | 'RESET';
  order: Order;
}

/** Cas A : la commande courante est remise à zéro. Cas G : un dispatch maison et son effet. */
@Injectable({ providedIn: 'root' })
export class OrderStore {
  private readonly current = new BehaviorSubject<Order | null>(null);
  readonly current$ = this.current.asObservable();
  private readonly actions = new Subject<OrderAction>();
  /** L'effet : une erreur HTTP termine le flux, les dispatchs suivants sont perdus. */
  readonly saved$ = this.actions.pipe(
    filter((action) => action.type === 'SAVE'),
    switchMap((action) => this.api.saveOrder(action.order)),
  );

  constructor(private api: ApiService) {}

  select(order: Order): void {
    this.current.next(order);
  }

  clear(): void {
    this.current.next(null);
  }

  dispatch(action: OrderAction): void {
    this.actions.next(action);
  }
}
