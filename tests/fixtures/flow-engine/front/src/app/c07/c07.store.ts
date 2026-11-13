import { Injectable } from '@angular/core';
import { Subject, filter, switchMap } from 'rxjs';
import { ManyAction, ManyApi } from './c07.api';

@Injectable({ providedIn: 'root' })
export class ManyStore {
  private readonly actions = new Subject<ManyAction>();
  readonly saved$ = this.actions.pipe(
    filter((a) => a.type === 'SAVE'),
    switchMap(() => this.api.save()),
  );
  readonly loaded$ = this.actions.pipe(
    filter((a) => a.type === 'LOAD'),
    switchMap(() => this.api.list()),
  );

  constructor(private api: ManyApi) {}

  dispatch(action: ManyAction): void {
    this.actions.next(action);
  }
}
