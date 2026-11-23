import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Client } from '../api.service';

/** Cas B : le client choisi reste dans le store applicatif ; rien ne le remet à zéro. */
@Injectable({ providedIn: 'root' })
export class ClientStore {
  private readonly selected = new BehaviorSubject<Client | null>(null);
  readonly selected$ = this.selected.asObservable();
  private readonly history = new BehaviorSubject<Client[]>([]);
  readonly history$ = this.history.asObservable();

  selectClient(client: Client): void {
    this.selected.next(client);
    this.history.next([...this.history.value, client]);
  }

  /** Remet l'historique à zéro, pas le client choisi (écrit avec lui). */
  forgetHistory(): void {
    this.history.next([]);
  }

  /** Modifie l'objet émis en place : les consommateurs ne sont pas notifiés. */
  rename(name: string): void {
    this.selected.value!.name = name;
  }
}
