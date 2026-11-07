import { Component } from '@angular/core';
import { FormBuilder } from '@angular/forms';

/** Réutilisé par plusieurs onglets. */
@Component({
  selector: 'app-address',
  template: `<form [formGroup]="form">
    <label for="street">Rue</label><input id="street" formControlName="street" />
  </form>`,
})
export class AddressComponent {
  readonly form = this.fb.group({ street: [''] });

  constructor(private fb: FormBuilder) {}
}
