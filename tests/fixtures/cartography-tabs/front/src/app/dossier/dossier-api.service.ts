import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class DossierApi {
  constructor(private http: HttpClient) {}

  validate() {
    return this.http.post<{ valid: boolean }>('/api/dossier/validate', {});
  }

  documents() {
    return this.http.get('/api/dossier/documents');
  }

  history() {
    return this.http.get('/api/dossier/history');
  }
}
