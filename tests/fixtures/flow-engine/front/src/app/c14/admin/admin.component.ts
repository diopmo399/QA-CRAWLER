import { Component } from '@angular/core';
import { PanelStore } from '@c14/admin/panel.store';

@Component({ selector: 'app-c14-admin', template: '<button (click)="open()">Open</button>' })
export class AdminPanelComponent {
  constructor(private store: PanelStore) {}

  open(): void {
    this.store.load();
  }
}
