import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class CartApi {
  constructor(private http: HttpClient) {}

  list(): Observable<number[]> {
    return this.http.get<number[]>('/api/c18/cart');
  }

  save(): Observable<void> {
    return this.http.put<void>('/api/c18/cart', {});
  }

  track(): Observable<void> {
    return this.http.post<void>('/api/c18/track', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c18/cart');
  }
}
