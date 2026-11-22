import { Component } from '@angular/core';
import { AliasStore } from './c01.store';

@Component({ selector: 'app-c01', template: '<button (click)="save()">Save</button>' })
export class AliasComponent {
  constructor(private store: AliasStore) {}

  save(): void {
    const currentStore = this.store;
    currentStore.dispatch({ type: 'SAVE' });
  }
}
