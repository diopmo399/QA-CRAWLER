import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { ApiClient } from '../core/api-client';
import { ActivationStatus } from './activation.models';

@Injectable({ providedIn: 'root' })
export class ActivationService {
  constructor(
    private client: ApiClient,
    private http: HttpClient,
  ) {}

  activate(id: string) {
    return this.client.post<ActivationStatus>('/api/activation', { id });
  }

  status() {
    return this.http.request<ActivationStatus>('GET', '/api/activation/status');
  }

  items(kind: string) {
    return this.http.get(`/${kind}/items`);
  }
}
