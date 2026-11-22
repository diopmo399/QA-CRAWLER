import { Component } from '@angular/core';
import { CatalogStore } from '@c14-shared';

@Component({ selector: 'app-c14-catalog', template: '<button (click)="open()">Open</button>' })
export class CatalogPanelComponent {
  constructor(private store: CatalogStore) {}

  open(): void {
    this.store.load();
  }
}
