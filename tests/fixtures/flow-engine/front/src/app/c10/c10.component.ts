import { Component } from '@angular/core';
import { LooseAction } from './c10.api';
import { LooseStore } from './c10.store';
import { RemoteGateway } from './missing/remote.gateway';

@Component({ selector: 'app-c10', template: '<button (click)="replay()">Replay</button>' })
export class LooseComponent {
  constructor(
    private store: LooseStore,
    private remote: RemoteGateway,
  ) {}

  replay(): void {
    const action = JSON.parse(localStorage.getItem('last') ?? '{}') as LooseAction;
    this.store.dispatch(action);
  }

  push(): void {
    this.remote.send();
  }
}
