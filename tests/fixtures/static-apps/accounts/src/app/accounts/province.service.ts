import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ProvinceService {
  constructor(private http: HttpClient) {}

  list(country: string) {
    return this.http.get<string[]>('/api/provinces', { params: { country } });
  }
}
