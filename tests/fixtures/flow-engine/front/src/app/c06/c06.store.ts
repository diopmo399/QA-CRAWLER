import { Injectable } from '@angular/core';
import { Subject, filter, switchMap } from 'rxjs';
import { NamedAction, NamedApi } from './c06.api';
import { isSave, onAction } from './c06.operators';

@Injectable({ providedIn: 'root' })
export class NamedStore {
  private readonly actions = new Subject<NamedAction>();
  readonly saved$ = this.actions.pipe(
    filter(isSave),
    switchMap(() => this.api.save()),
  );
  readonly loaded$ = this.actions.pipe(
    onAction('LOAD'),
    switchMap(() => this.api.list()),
  );
  readonly rejected$ = this.actions.pipe(
    filter((a) => this.isReject(a)),
    switchMap(() => this.api.remove()),
  );

  constructor(private api: NamedApi) {}

  dispatch(action: NamedAction): void {
    this.actions.next(action);
  }

  private isReject(action: NamedAction): boolean {
    return action.type === 'REJECT';
  }
}
