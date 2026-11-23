import { Component } from '@angular/core';
import { SessionStore } from '../workshop/draft.store';
import { PrefsStore } from './prefs.store';

@Component({ selector: 'app-prefs', templateUrl: './prefs.component.html' })
export class PrefsComponent {
  readonly theme$ = this.prefs.theme$;
  readonly user$ = this.session.user;

  constructor(
    private prefs: PrefsStore,
    private session: SessionStore,
  ) {}

  pick(theme: string): void {
    this.prefs.choose(theme);
  }
}
