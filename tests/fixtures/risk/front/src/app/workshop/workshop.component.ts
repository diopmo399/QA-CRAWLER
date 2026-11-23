import { Component } from '@angular/core';
import { DraftStore, ScopedStore, SessionStore } from './draft.store';

@Component({
  selector: 'app-workshop',
  templateUrl: './workshop.component.html',
  providers: [ScopedStore],
})
export class WorkshopComponent {
  readonly step$ = this.steps.step$;
  readonly user$ = this.session.user;

  constructor(
    private drafts: DraftStore,
    private steps: ScopedStore,
    private session: SessionStore,
  ) {}

  save(text: string): void {
    this.drafts.write(text);
    this.steps.go(2);
  }

  enter(name: string): void {
    this.session.login(name);
  }
}
