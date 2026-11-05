import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { CompanyChange, CompanyQuery, NewCompany } from './company.models';

@Injectable({ providedIn: 'root' })
export class CompanyService {
  constructor(private http: HttpClient) {}

  create(company: NewCompany) {
    return this.http.post('/api/companies', company);
  }

  search(query: CompanyQuery) {
    return this.http.post('/api/companies/search', query);
  }

  update(change: CompanyChange) {
    return this.http.put('/api/companies/current', change);
  }

  load() {
    return this.http.get('/api/companies/current');
  }
}
