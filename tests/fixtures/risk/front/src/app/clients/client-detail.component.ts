import { Component } from '@angular/core';
import { ClientStore } from './client.store';

@Component({ selector: 'app-client-detail', templateUrl: './client-detail.component.html' })
export class ClientDetailComponent {
  readonly client$ = this.store.selected$;

  constructor(private store: ClientStore) {}
}
