import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { Commande, CommandeApiService } from './commande-api.service';

interface EtatCommande {
  valide: boolean;
  enregistree: boolean;
}

/** Valide (attente), met l'état à jour, puis enchaîne deux dispatch si l'état le permet. */
@Injectable({ providedIn: 'root' })
export class CommandeStore {
  private readonly etat = new BehaviorSubject<EtatCommande>({ valide: false, enregistree: false });
  readonly etat$ = this.etat.asObservable();

  constructor(private api: CommandeApiService) {}

  async validerEtEnregistrer(commande: Commande): Promise<void> {
    const valide = await firstValueFrom(this.api.valider(commande));
    this.etat.next({ ...this.etat.value, valide });
    if (this.etat.value.valide) {
      this.dispatch('ENREGISTRER', commande);
      this.dispatch('RAFRAICHIR', commande.id);
    }
  }

  dispatch(action: string, payload: unknown): void {
    switch (action) {
      case 'ENREGISTRER':
        this.api
          .creer(payload as Commande)
          .subscribe(() => this.etat.next({ ...this.etat.value, enregistree: true }));
        break;
      case 'RAFRAICHIR':
        this.api.lire(payload as number).subscribe();
        break;
    }
  }
}
