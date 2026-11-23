import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject, Subscription, takeUntil } from 'rxjs';
import { ClientStore } from '../clients/client.store';

/** Cas C : chaque souscription et l'écouteur sont libérés à la destruction. */
@Component({ selector: 'app-safe', templateUrl: './safe.component.html' })
export class SafeComponent implements OnInit, OnDestroy {
  name = '';
  count = 0;
  private sub?: Subscription;
  private readonly destroy$ = new Subject<void>();
  readonly history$ = this.store.history$;

  constructor(private store: ClientStore) {}

  ngOnInit(): void {
    this.sub = this.store.selected$.subscribe((client) => (this.name = client?.name ?? ''));
    this.store.history$.pipe(takeUntil(this.destroy$)).subscribe((list) => (this.count = list.length));
    window.addEventListener('scroll', this.onScroll);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.destroy$.next();
    this.destroy$.complete();
    window.removeEventListener('scroll', this.onScroll);
  }

  private readonly onScroll = (): void => {
    this.count += 0;
  };
}
