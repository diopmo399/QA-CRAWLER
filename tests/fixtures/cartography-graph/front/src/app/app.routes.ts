import { Routes } from '@angular/router';
import { CompanyCreateComponent } from './companies/company-create.component';
import { CompanyDetailsComponent } from './companies/company-details.component';
import { CompanyEditComponent } from './companies/company-edit.component';
import { CompanyFormComponent } from './companies/company-form.component';
import { CompanySearchComponent } from './companies/company-search.component';

export const routes: Routes = [
  { path: 'companies/new', component: CompanyFormComponent },
  { path: 'companies/quick', component: CompanyCreateComponent },
  { path: 'companies/search', component: CompanySearchComponent },
  { path: 'companies/current', component: CompanyDetailsComponent },
  { path: 'companies/current/edit', component: CompanyEditComponent },
];
