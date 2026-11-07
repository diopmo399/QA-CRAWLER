import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

/** Enveloppe maison : l'URL est passée par l'appelant. */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  constructor(private http: HttpClient) {}

  post<T>(url: string, body: unknown) {
    return this.http.post<T>(url, body);
  }
}
