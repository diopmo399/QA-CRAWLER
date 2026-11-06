import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { Action, ENREGISTRER, createAction, makeValidationAction, pickAction } from './actions';
import { AuditApi, ReqApi } from './req-api.service';

@Injectable({ providedIn: 'root' })
export class ReqStore {
  constructor(
    private api: ReqApi,
    private audit: AuditApi,
  ) {}

  dispatch(action: Action): void {
    this.api.execute(action).subscribe();
  }

  dispatchObs(action: Action): Observable<unknown> {
    return this.api.execute(action);
  }

  /** 1 + 5 : un alias simple et une fabrique d'action. */
  aliasSimple(form: unknown): void {
    const s = this.api;
    s.execute(makeValidationAction(form)).subscribe();
  }

  /** 2 : un alias d'alias. */
  aliasChain(form: unknown): void {
    const a = this.api;
    const b = a;
    b.execute(createAction(ENREGISTRER, form)).subscribe();
  }

  /** 3 : un alias réaffecté : deux cibles possibles. */
  aliasReassigned(flag: boolean): void {
    let target: ReqApi | AuditApi = this.api;
    if (flag) {
      target = this.audit;
    }
    target.ping().subscribe();
  }

  /** 4 : une méthode détachée de son objet. */
  detached(form: unknown): void {
    const { execute } = this.api;
    execute(makeValidationAction(form)).subscribe();
  }

  /** Le retour d'une méthode, et un paramètre typé. */
  viaGetter(): void {
    this.getApi().ping().subscribe();
  }

  getApi(): ReqApi {
    return this.api;
  }

  viaParam(api: ReqApi): void {
    api.ping().subscribe();
  }

  /** Deux retours possibles dans la fabrique : toutes les branches restent possibles. */
  ambiguous(flag: boolean, data: unknown): void {
    this.dispatch(pickAction(flag, data));
  }
}
