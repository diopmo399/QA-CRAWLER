import { Component } from '@angular/core';
import { FilterStore } from './filter.store';

@Component({ selector: 'app-tab-resume', templateUrl: './tab-resume.component.html' })
export class TabResumeComponent {
  readonly filter$ = this.filters.filter$;

  constructor(private filters: FilterStore) {}
}
