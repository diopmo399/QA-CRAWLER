import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class OrderApi {
  constructor(private http: HttpClient) {}

  validate(form: unknown): Observable<{ valid: boolean }> {
    return this.http.post<{ valid: boolean }>('/api/orders/validate', form);
  }

  check(): Observable<boolean> {
    return this.http.get<boolean>('/api/orders/check');
  }

  submit(payload: unknown): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/orders', payload);
  }

  cancel(id: unknown): Observable<void> {
    return this.http.post<void>(`/api/orders/${String(id)}/cancel`, {});
  }

  archive(id: unknown): Observable<void> {
    return this.http.post<void>(`/api/orders/${String(id)}/archive`, {});
  }

  refresh(): Observable<unknown> {
    return this.http.get('/api/orders');
  }

  search(q: string): Observable<unknown[]> {
    return this.http.get<unknown[]>(`/api/orders/search?q=${q}`);
  }
}
