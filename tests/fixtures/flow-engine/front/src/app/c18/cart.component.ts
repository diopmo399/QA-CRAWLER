import { Component, effect, inject } from '@angular/core';
import { CartApi } from './cart.api';
import { CartStore } from './cart.store';

@Component({
  selector: 'app-c18',
  template: '<button (click)="add()">Add</button><p>{{ store.total() }}</p>',
})
export class CartComponent {
  readonly store = inject(CartStore);
  private readonly api = inject(CartApi);

  // Un effet déclaré en propriété, qui lit le signal d'une dépendance.
  private readonly watcher = effect(() => {
    if (this.store.coupon()) this.api.remove().subscribe();
  });

  constructor() {
    this.store.saved$.subscribe();
  }

  add(): void {
    this.store.setQuantity(3);
  }

  coupon(): void {
    this.store.applyCoupon('X');
  }

  show(): number {
    return this.store.current();
  }
}
