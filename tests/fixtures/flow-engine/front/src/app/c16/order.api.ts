import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class OrderApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c16/orders');
  }

  save(): Observable<void> {
    return this.http.post<void>('/api/c16/orders', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c16/orders/1');
  }

  audit(): Observable<void> {
    return this.http.post<void>('/api/c16/audit', {});
  }
}
