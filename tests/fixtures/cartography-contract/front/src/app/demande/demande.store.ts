import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Decision, DemandesService } from '../api/demandes.service';

@Injectable({ providedIn: 'root' })
export class DemandeStore {
  readonly etat$ = new BehaviorSubject<string>('initial');

  constructor(private api: DemandesService) {}

  valider(id: number, decision: Decision): void {
    this.api.validerDemande(id, decision).subscribe(() => this.etat$.next('validée'));
  }

  charger(id: number): void {
    this.api.lireDemande(id).subscribe(() => this.etat$.next('chargée'));
  }
}
