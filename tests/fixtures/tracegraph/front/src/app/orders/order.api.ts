import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class OrderApi {
  constructor(private http: HttpClient) {}

  list(): Observable<{ id: string; title: string }[]> {
    return this.http.get<{ id: string; title: string }[]>('/api/orders');
  }

  create(title: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/orders', { title });
  }
}
