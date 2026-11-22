import { Component, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { OrderPageActions, loadOrders, saveOrder } from './order.actions';
import { selectBusy, selectGhost, selectItems } from './order.selectors';

@Component({
  selector: 'app-c16',
  template: '<button (click)="save()">Save</button><p>{{ items$ | async }}</p>',
})
export class OrderPageComponent {
  private readonly store = inject(Store);
  // L'état que les sélecteurs lisent est celui du réducteur enregistré sous la même clé.
  readonly items$ = this.store.select(selectItems);
  readonly busy = this.store.selectSignal(selectBusy);
  readonly ghost$ = this.store.select(selectGhost);

  refresh(): void {
    this.store.dispatch(loadOrders());
  }

  save(): void {
    this.store.dispatch(saveOrder({ id: '1' }));
  }

  remove(): void {
    this.store.dispatch(OrderPageActions.removeOrder({ id: '1' }));
  }

  // Une action que personne ne traite.
  open(): void {
    this.store.dispatch(OrderPageActions.opened());
  }
}
