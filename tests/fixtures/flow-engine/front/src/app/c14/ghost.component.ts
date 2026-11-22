import { Component } from '@angular/core';
// Un alias que rien ne déclare : la classe homonyme reste ambiguë, aucune des deux n'est choisie.
import { PanelStore } from '@undeclared/panel.store';

@Component({ selector: 'app-c14-ghost', template: '<button (click)="open()">Open</button>' })
export class GhostPanelComponent {
  constructor(private store: PanelStore) {}

  open(): void {
    this.store.load();
  }
}
