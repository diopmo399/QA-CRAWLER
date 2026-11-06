import { Component, signal } from '@angular/core';
import { CommandeApiService, Commande } from './commande-api.service';
import { CommandeStore } from './commande.store';

@Component({
  selector: 'app-commandes-page',
  templateUrl: './commandes-page.component.html',
})
export class CommandesPageComponent {
  readonly etat$ = this.store.etat$;
  readonly detailsVisibles = signal(false);
  commande: Commande = { id: 1, client: '' };
  total = 0;

  constructor(
    private store: CommandeStore,
    private api: CommandeApiService,
  ) {}

  valider(): void {
    void this.store.validerEtEnregistrer(this.commande);
  }

  /** Parcours local : rien ne quitte le frontal. */
  basculerDetails(): void {
    this.detailsVisibles.set(!this.detailsVisibles());
  }

  /** L'Observable est construit mais jamais souscrit : aucune requête n'est démontrée. */
  supprimer(): void {
    this.api.supprimer(this.commande.id);
  }

  compter(): void {
    this.api.total().subscribe((n) => (this.total = n));
  }
}
