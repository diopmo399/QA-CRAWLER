import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type InitAction = { type: 'LOAD' } | { type: 'SAVE' } | { type: 'VALIDATE' } | { type: 'REJECT' };

@Injectable({ providedIn: 'root' })
export class InitApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c03/items');
  }

  save(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/c03/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c03/items/1');
  }
}
