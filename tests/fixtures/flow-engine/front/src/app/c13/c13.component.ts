import { Component } from '@angular/core';
import { BaseStore, DraftStore } from './c13.stores';

@Component({ selector: 'app-c13', template: '<button (click)="saveDraft()">Save</button>' })
export class PolyComponent {
  constructor(
    private draft: DraftStore,
    private any: BaseStore,
  ) {}

  saveDraft(): void {
    this.draft.dispatch({ type: 'SAVE' });
  }

  saveAny(): void {
    this.any.dispatch({ type: 'SAVE' });
  }
}
