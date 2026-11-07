import { Component } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { OrderAction } from './actions';
import { OrderApi } from './order-api.service';
import { OrderFlow } from './order-flow.service';
import { OrderStore } from './order.store';
import { ValidationStore } from './validation.store';

@Component({
  selector: 'app-order',
  template: `<section>
    <h1>Commandes</h1>
    <button type="button" (click)="save()">Enregistrer</button>
    <button type="button" (click)="cancel()">Annuler</button>
    <button type="button" (click)="run(selected)">Exécuter</button>
    <button type="button" (click)="check()">Vérifier</button>
    <button type="button" (click)="preview()">Aperçu</button>
    <button type="button" (click)="close()">Fermer</button>
  </section>`,
})
export class OrderComponent {
  selected: OrderAction = OrderAction.Submit;
  form = {};
  id = '42';

  constructor(
    private orders: OrderStore,
    private validation: ValidationStore,
    private flow: OrderFlow,
    private api: OrderApi,
  ) {}

  /** C : attend la validation (await), puis dispatch seulement si elle est valide. */
  async save(): Promise<void> {
    const ok = await firstValueFrom(this.validation.validate(this.form));
    if (ok) {
      this.orders.dispatch(OrderAction.Submit, this.form);
    }
  }

  /** Négatif : Annuler n'atteint que le traitement d'annulation. */
  cancel(): void {
    this.orders.dispatch(OrderAction.Cancel, this.id);
  }

  /** L'action vient d'une donnée du composant : la branche n'est pas déterminable statiquement. */
  run(action: OrderAction): void {
    this.orders.dispatch(action, this.id);
  }

  /** D + E + B */
  check(): void {
    this.flow.submitChecked(this.form);
    this.validation.publish(this.form);
    this.validation.validateThenSubmit(this.form);
  }

  /** Négatif : un Observable jamais souscrit n'exécute rien. */
  preview(): void {
    this.api.submit(this.form);
  }

  /** Un objet porteur de l'action. */
  close(): void {
    this.orders.reduce({ type: OrderAction.Cancel, id: this.id });
  }
}
