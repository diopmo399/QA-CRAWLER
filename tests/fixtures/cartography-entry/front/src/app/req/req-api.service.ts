import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { Action, ENREGISTRER, VALIDER } from './actions';

@Injectable({ providedIn: 'root' })
export class ReqApi {
  constructor(private http: HttpClient) {}

  /** Une méthode générique : un appel HTTP par branche. */
  execute(action: Action): Observable<unknown> {
    if (action.type === VALIDER) {
      return this.http.post('/api/req/validation', action.payload);
    }
    if (action.type === ENREGISTRER) {
      return this.http.post('/api/req/enregistrement', action.payload);
    }
    return this.http.get('/api/req/inconnue');
  }

  ping(): Observable<unknown> {
    return this.http.get('/api/req/ping');
  }
}

@Injectable({ providedIn: 'root' })
export class AuditApi {
  constructor(private http: HttpClient) {}

  ping(): Observable<unknown> {
    return this.http.get('/api/audit/ping');
  }
}
