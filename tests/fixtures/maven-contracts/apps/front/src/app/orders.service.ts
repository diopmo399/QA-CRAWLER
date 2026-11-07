import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class OrdersService {
  constructor(private http: HttpClient) {}
  one(id: string) {
    return this.http.get(`/api/orders/${id}`);
  }
  create(body: unknown) {
    return this.http.post('/api/orders', body);
  }
  search(q: string) {
    return this.http.get('/api/orders/search', { params: { q } });
  }
  // Une route qu'aucun contrat ne déclare : jamais raccordée.
  archive(id: string) {
    return this.http.post(`/api/orders/${id}/archive`, {});
  }
}
