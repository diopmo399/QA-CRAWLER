import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, Client } from '../api.service';
import { ClientStore } from './client.store';

@Component({ selector: 'app-client-list', templateUrl: './client-list.component.html' })
export class ClientListComponent {
  readonly clients$ = this.api.clients();

  constructor(
    private api: ApiService,
    private store: ClientStore,
    private router: Router,
  ) {}

  open(client: Client): void {
    this.store.selectClient(client);
    void this.router.navigate(['/clients', client.id]);
  }

  rename(name: string): void {
    this.store.rename(name);
  }

  forget(): void {
    this.store.forgetHistory();
  }
}
