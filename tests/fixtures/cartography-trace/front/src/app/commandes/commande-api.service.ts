import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Commande {
  id: number;
  client: string;
}

@Injectable({ providedIn: 'root' })
export class CommandeApiService {
  private readonly base = environment.api;

  constructor(private http: HttpClient) {}

  valider(commande: Commande): Observable<boolean> {
    return this.http.post<boolean>(`${this.base}/commandes/validation`, commande);
  }

  creer(commande: Commande): Observable<Commande> {
    return this.http.post<Commande>(`${this.base}/commandes`, commande);
  }

  lire(id: number): Observable<Commande> {
    return this.http.get<Commande>(`${this.base}/commandes/${id}`);
  }

  total(): Observable<number> {
    return this.http.get<number>(`${this.base}/stats/total`);
  }

  supprimer(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/commandes/${id}`);
  }
}
