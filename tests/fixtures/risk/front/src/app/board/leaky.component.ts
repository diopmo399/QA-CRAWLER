import { Component, OnInit } from '@angular/core';
import { ClientStore } from '../clients/client.store';

/** Cas D : la souscription au store et l'écouteur survivent au composant. */
@Component({ selector: 'app-leaky', templateUrl: './leaky.component.html' })
export class LeakyComponent implements OnInit {
  name = '';
  ticks = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private store: ClientStore) {}

  ngOnInit(): void {
    this.store.selected$.subscribe((client) => (this.name = client?.name ?? ''));
    window.addEventListener('resize', this.onResize);
    this.timer = setInterval(() => (this.ticks += 1), 1000);
  }

  /** Chaque clic ajoute une souscription au store : le traitement s'exécute une fois de plus à chaque fois. */
  watch(): void {
    this.store.history$.subscribe((list) => (this.ticks = list.length));
  }

  private readonly onResize = (): void => {
    this.ticks = 0;
  };
}
