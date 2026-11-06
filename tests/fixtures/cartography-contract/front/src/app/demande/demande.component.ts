import { Component } from '@angular/core';
import { DemandeStore } from './demande.store';
import { HistoriqueService } from './historique.service';

@Component({
  selector: 'app-demande',
  templateUrl: './demande.component.html',
})
export class DemandeComponent {
  id = 12;
  type = 'demandes';

  constructor(
    private store: DemandeStore,
    private historiqueService: HistoriqueService,
  ) {}

  valider(): void {
    this.store.valider(this.id, { motif: 'conforme', accepte: true });
  }

  charger(): void {
    this.store.charger(this.id);
  }

  voirHistorique(): void {
    this.historiqueService.historique(this.type).subscribe();
  }

  remplacer(): void {
    this.historiqueService.remplacer(this.id, 'autre').subscribe();
  }

  rapport(): void {
    this.historiqueService.rapport(this.id).subscribe();
  }

  archiver(): void {
    this.historiqueService.archiver(this.id).subscribe();
  }

  dossier(): void {
    this.historiqueService.dossier(this.id).subscribe();
  }
}
