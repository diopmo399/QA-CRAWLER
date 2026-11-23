import { Component } from '@angular/core';
import { FilterStore } from './filter.store';

@Component({ selector: 'app-tab-notes', templateUrl: './tab-notes.component.html' })
export class TabNotesComponent {
  constructor(private filters: FilterStore) {}

  narrow(value: string): void {
    this.filters.apply(value);
  }
}
