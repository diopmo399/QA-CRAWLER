import { Component, DestroyRef, OnDestroy, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { ApiService, Order } from '../api.service';
import { OrderStore } from './order.store';

@Component({ selector: 'app-order-page', templateUrl: './order-page.component.html' })
export class OrderPageComponent implements OnInit, OnDestroy {
  private readonly destroyRef = inject(DestroyRef);
  readonly current$ = this.store.current$;
  order: Order = { id: 1, total: 0 };
  loading = false;
  saving = false;
  saved = 0;

  constructor(
    private store: OrderStore,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.store.select(this.order);
    this.store.saved$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => (this.saved += 1));
  }

  ngOnDestroy(): void {
    this.store.clear();
  }

  /** Cas F : une erreur laisse l'indicateur actif. */
  save(): void {
    this.loading = true;
    this.api.saveOrder(this.order).subscribe({
      next: () => {
        this.loading = false;
      },
    });
  }

  /** L'indicateur revient à faux dans tous les cas (finalize). */
  saveSafely(): void {
    this.saving = true;
    this.api
      .saveOrder(this.order)
      .pipe(finalize(() => (this.saving = false)))
      .subscribe();
  }

  /** Sans suite d'erreur : en cas d'échec, la commande n'est jamais remise dans le store. */
  reload(): void {
    this.api.saveOrder(this.order).subscribe((order) => this.store.select(order));
  }

  /** Cas G : l'appelant passe par le dispatch du store. */
  submit(): void {
    this.store.dispatch({ type: 'SAVE', order: this.order });
  }
}
