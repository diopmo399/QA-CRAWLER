import { Component } from '@angular/core';
import { DossierState } from './stores';

@Component({
  selector: 'app-identity-form',
  template: `<section>
    <h2>Identité</h2>
    <button type="button" (click)="validate()">Valider</button>
  </section>`,
})
export class IdentityFormComponent {
  constructor(private dossier: DossierState) {}

  validate(): void {
    this.dossier.validate();
  }
}
