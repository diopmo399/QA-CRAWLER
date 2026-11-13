import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';
import { CartApi } from './cart.api';

@Injectable({ providedIn: 'root' })
export class CartStore {
  private readonly api = inject(CartApi);

  readonly quantity = signal(0);
  readonly coupon = signal('');
  // Un signal calculé : il suit les signaux que son calcul lit.
  readonly total = computed(() => this.quantity() * 2);
  // Un pont vers RxJS : chaque changement du total relance l'appel.
  readonly saved$ = toObservable(this.total).pipe(switchMap(() => this.api.save()));
  // Un pont depuis RxJS : le signal suit le flux.
  readonly items = toSignal(this.api.list());

  constructor() {
    // Rejoué à chaque changement du total, donc de la quantité.
    effect(() => {
      if (this.total() > 10) this.api.track().subscribe();
    });
  }

  setQuantity(value: number): void {
    this.quantity.set(value);
  }

  applyCoupon(code: string): void {
    this.coupon.set(code);
  }

  // Lire un signal dans une méthode n'est ni un appel ni un abonnement.
  current(): number {
    return this.quantity();
  }
}
