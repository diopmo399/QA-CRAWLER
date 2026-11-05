import { Component } from '@angular/core';
import { DossierState, TabState, UserState } from './stores';

@Component({
  selector: 'app-dossier',
  templateUrl: './dossier.component.html',
})
export class DossierComponent {
  readonly extraTabs = [
    { label: 'Contacts', key: 'contacts' },
    { label: 'Notes', key: 'notes' },
  ];

  constructor(
    public tabs: TabState,
    public dossier: DossierState,
    public users: UserState,
  ) {}

  onTab(event: { index: number }): void {
    this.tabs.select(event.index);
  }
}
