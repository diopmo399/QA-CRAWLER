import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, Client, Contract } from '../api.service';
import { ClientStore } from './client.store';

/** Lit le client choisi à l'ouverture, sans le choisir : il peut venir d'un autre parcours. */
@Component({ selector: 'app-contrat', templateUrl: './contrat.component.html' })
export class ContratComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  client: Client | null = null;
  contracts: Contract[] = [];

  constructor(
    private store: ClientStore,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.store.selected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((client) => {
      this.client = client;
      if (client) this.loadContracts(client.id);
    });
  }

  loadContracts(clientId: number): void {
    this.api.contracts(clientId).subscribe({
      next: (list) => (this.contracts = list),
      error: () => (this.contracts = []),
    });
  }
}
