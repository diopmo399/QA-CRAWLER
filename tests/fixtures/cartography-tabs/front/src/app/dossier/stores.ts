import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { DossierApi } from './dossier-api.service';

/** L'onglet actif, gardé dans un store. */
@Injectable({ providedIn: 'root' })
export class TabState {
  private readonly selected = new BehaviorSubject<number>(0);
  readonly selected$ = this.selected.asObservable();

  select(index: number): void {
    this.selected.next(index);
  }
}

/** La validation du dossier : l'onglet Identité l'écrit, l'onglet Documents la lit. */
@Injectable({ providedIn: 'root' })
export class DossierState {
  private readonly validated = new BehaviorSubject<boolean>(false);
  readonly validated$ = this.validated.asObservable();

  constructor(private api: DossierApi) {}

  validate(): void {
    this.api.validate().subscribe((r) => this.validated.next(r.valid));
  }
}

@Injectable({ providedIn: 'root' })
export class UserState {
  private readonly roles = new BehaviorSubject<string[]>([]);
  readonly isAdmin$ = this.roles.asObservable();
}
