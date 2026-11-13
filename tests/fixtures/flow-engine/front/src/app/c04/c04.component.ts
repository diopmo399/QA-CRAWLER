import { Component } from '@angular/core';
import { Observable } from 'rxjs';
import { CheckedStore } from './c04.store';

export abstract class RuleChecker {
  abstract check(value: string): Observable<boolean>;
}

@Component({ selector: 'app-c04', template: '<button (click)="send()">Send</button>' })
export class CheckedComponent {
  ready = false;

  constructor(
    private store: CheckedStore,
    private checker: RuleChecker,
  ) {}

  send(): void {
    if (!this.ready) return;
    this.checker.check('x').subscribe((ok) => {
      if (ok) this.store.dispatch({ type: 'SAVE' });
      else this.store.dispatch({ type: 'REJECT' });
    });
  }
}
