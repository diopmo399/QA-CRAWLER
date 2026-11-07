import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { ApiClient } from '../api/api-client';

@Injectable({ providedIn: 'root' })
export class HistoriqueService {
  constructor(
    private http: HttpClient,
    private client: ApiClient,
  ) {}

  historique(type: string) {
    return this.http.get<string[]>(`${environment.apiBase}/${type}/historique`);
  }

  remplacer(id: number, motif: string) {
    return this.http.put(`${environment.apiBase}/demandes/${id}/validation`, { motif });
  }

  rapport(id: number) {
    return this.http.get(`${environment.apiBase}/rapports/${id}`);
  }

  archiver(id: number) {
    return this.client.post(`${environment.apiBase}/demandes/${id}/archive`, {});
  }

  dossier(id: number) {
    return this.http.get(`${environment.apiBase}/dossiers/${id}`);
  }
}
