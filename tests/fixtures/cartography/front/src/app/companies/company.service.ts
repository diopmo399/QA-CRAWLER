import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { NewCompany } from './company.models';

@Injectable({ providedIn: 'root' })
export class CompanyService {
  constructor(private http: HttpClient) {}

  create(company: NewCompany) {
    return this.http.post('/api/companies', company);
  }
}
