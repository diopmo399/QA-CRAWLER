import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, filter, map, switchMap } from 'rxjs';
import { ENREGISTRER, createAction, makeSaveAction, makeValidationAction } from './actions';
import { ReqApi } from './req-api.service';
import { ReqStore } from './req.store';

@Injectable({ providedIn: 'root' })
export class ValidationStore {
  private readonly allowed = new BehaviorSubject<boolean>(false);
  readonly canValidate$ = this.allowed.asObservable();

  constructor(
    private api: ReqApi,
    private req: ReqStore,
  ) {}

  validate(data: unknown): Observable<{ valid: boolean; data: unknown }> {
    return this.api.ping().pipe(map(() => ({ valid: true, data })));
  }

  /** 11 + 14 : un dispatch qui dépend d'une émission valide, annulable par switchMap. */
  validateThenSave(data: unknown): void {
    this.validate(data)
      .pipe(
        filter((result) => result.valid),
        switchMap((result) => this.req.dispatchObs(createAction(ENREGISTRER, result.data))),
      )
      .subscribe();
  }

  /** 12 : plusieurs dispatch après une validation. */
  validateAndDispatchBoth(data: unknown): void {
    this.validate(data).subscribe((result) => {
      this.req.dispatch(makeValidationAction(result.data));
      this.req.dispatch(makeSaveAction(result.data));
    });
  }

  /** 13 : une chaîne jamais souscrite : la continuation n'est pas exécutée. */
  lost(data: unknown): void {
    this.validate(data).pipe(switchMap((result) => this.req.dispatchObs(makeSaveAction(result.data))));
  }
}
