import { Injectable } from '@angular/core';
import { Subject, filter, switchMap } from 'rxjs';
import { GateAction, GateApi, GateMode } from './c15.api';

@Injectable({ providedIn: 'root' })
export class GateStore {
  private readonly actions = new Subject<GateAction>();
  // Une négation : tout sauf LOAD.
  readonly notLoad$ = this.actions.pipe(
    filter((a) => a.type !== 'LOAD'),
    switchMap(() => this.api.audit()),
  );
  // Une conjonction : le terme sur le type restreint, l'autre terme ne peut que restreindre davantage.
  readonly urgentSave$ = this.actions.pipe(
    filter((a) => a.type === 'SAVE' && a.urgent === true),
    switchMap(() => this.api.save()),
  );
  // La négation d'une liste : ni SAVE ni REJECT.
  readonly others$ = this.actions.pipe(
    filter((a) => !['SAVE', 'REJECT'].includes(a.type)),
    switchMap(() => this.api.list()),
  );

  constructor(private api: GateApi) {}

  dispatch(action: GateAction): void {
    this.actions.next(action);
  }

  run(mode: GateMode): void {
    switch (mode) {
      case GateMode.Create:
        this.api.save().subscribe();
        break;
      case GateMode.Update:
        this.api.list().subscribe();
        break;
      case GateMode.Remove:
        this.api.remove().subscribe();
        break;
    }
  }
}
