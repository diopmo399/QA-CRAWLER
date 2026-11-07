import { Component } from '@angular/core';
import { createAction, makeSaveAction } from './actions';
import { ReqStore } from './req.store';
import { ValidationStore } from './validation.store';

@Component({
  selector: 'app-req',
  templateUrl: './req.component.html',
})
export class ReqComponent {
  form = { value: {} };
  tabs = [{ label: 'Annexe' }];
  handlers = [(): void => undefined];
  canValidate$ = this.validation.canValidate$;

  constructor(
    public store: ReqStore,
    private validation: ValidationStore,
  ) {}

  submit(): void {
    this.validation.validateThenSave(this.form.value);
  }

  validate(): void {
    this.validation.validateAndDispatchBoth(this.form.value);
  }

  run(type: string): void {
    this.store.dispatch(createAction(type, null));
  }

  quick(): void {
    this.store.aliasSimple(this.form.value);
  }

  refresh(): void {
    this.store.viaGetter();
  }

  onSaved(): void {
    this.store.dispatch(makeSaveAction(this.form.value));
  }

  /** Aucun élément du gabarit ne l'appelle : point d'entrée technique seulement. */
  technical(): void {
    this.store.aliasChain(this.form.value);
    this.validation.lost(this.form.value);
    this.store.ambiguous(true, this.form.value);
    this.store.aliasReassigned(true);
    this.store.detached(this.form.value);
  }
}
