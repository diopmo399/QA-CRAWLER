import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface NotesState {
  /** Le brouillon saisi dans le dialogue (vide si rien n'a été écrit). */
  brouillon: string;
  fermeA: number;
}

/** Le dialogue des notes et son dernier état, partagés entre le composant et le dialogue. */
@Injectable({ providedIn: 'root' })
export class NotesService {
  readonly ouvert$ = new Subject<boolean>();
  private etat: NotesState | undefined;

  ouvrir(): void {
    this.ouvert$.next(true);
  }

  fermer(brouillon: string): void {
    this.etat = { brouillon, fermeA: Date.now() };
    this.ouvert$.next(false);
  }

  dernierBrouillon(): NotesState | undefined {
    return this.etat;
  }
}
