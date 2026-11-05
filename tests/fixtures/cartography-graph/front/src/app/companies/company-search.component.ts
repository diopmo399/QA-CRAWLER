import { Component, inject } from '@angular/core';
import { FormBuilder } from '@angular/forms';
import { CompanyQuery } from './company.models';
import { CompanyService } from './company.service';

@Component({
  selector: 'app-company-search',
  template: `<form [formGroup]="form" (ngSubmit)="searchCompany()">
    <label for="q">Search</label>
    <input id="q" type="text" formControlName="query" />
    <button type="submit">Search</button>
  </form>`,
})
export class CompanySearchComponent {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(CompanyService);

  form = this.fb.group({
    query: [''],
  });

  searchCompany(): void {
    const query: CompanyQuery = { query: this.form.controls.query.value };
    this.service.search(query).subscribe();
  }
}
