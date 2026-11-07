/* Client généré par openapi-generator (typescript-angular) depuis demandes.yaml. */
import { Inject, Injectable, Optional } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { BASE_PATH } from './variables';

export interface Decision {
  motif: string;
  accepte?: boolean;
}

@Injectable({ providedIn: 'root' })
export class DemandesService {
  protected basePath = 'http://localhost';

  constructor(
    protected httpClient: HttpClient,
    @Optional() @Inject(BASE_PATH) basePath: string,
  ) {
    if (basePath) {
      this.basePath = basePath;
    }
  }

  public validerDemande(demandeId: number, decision: Decision): Observable<unknown> {
    const localVarPath = `/demandes/${encodeURIComponent(String(demandeId))}/validation`;
    return this.httpClient.request<unknown>('post', `${this.basePath}${localVarPath}`, { body: decision });
  }

  public lireDemande(demandeId: number): Observable<unknown> {
    return this.httpClient.request<unknown>(
      'get',
      `${this.basePath}/demandes/${encodeURIComponent(String(demandeId))}`,
      {},
    );
  }
}
