import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../environments/environment';

@Injectable({ providedIn: 'root' })
export class DossiersService {
  constructor(private http: HttpClient) {}

  lire(id: number) {
    return this.http.get(`${environment.apiBase}/dossiers/${id}`);
  }

  creer(dossier: unknown) {
    return this.http.post(`${environment.apiBase}/dossiers`, dossier);
  }

  rapports() {
    return this.http.get(`${environment.apiBase}/rapports/mensuels`);
  }

  anciens() {
    return this.http.get('/legacy/rapports');
  }
}
