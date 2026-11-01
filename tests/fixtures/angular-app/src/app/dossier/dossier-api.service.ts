import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface Dossier {
  id?: number;
  code: string;
  titre: string;
  categorie: string;
  urgent: boolean;
}

@Injectable({ providedIn: 'root' })
export class DossierApiService {
  constructor(private readonly http: HttpClient) {}

  creer(dossier: Dossier): Observable<Dossier> {
    return this.http.post<Dossier>('/api/dossiers', dossier);
  }

  recents(): Observable<Dossier[]> {
    return this.http.get<Dossier[]>('/api/dossiers/recents');
  }
}
