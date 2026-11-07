import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

/** Un client HTTP maison : l'URL est reçue en paramètre. */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly base = environment.apiUrl;

  constructor(private http: HttpClient) {}

  post<T>(url: string, body: unknown) {
    return this.http.post<T>(`${this.base}${url}`, body);
  }
}
