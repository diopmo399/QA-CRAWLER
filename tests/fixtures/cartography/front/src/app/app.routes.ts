import { Routes } from '@angular/router';
import { CompanyFormComponent } from './companies/company-form.component';
import { RequestCreateComponent } from './requests/request-create.component';
import { RequestEditComponent } from './requests/request-edit.component';

export const routes: Routes = [
  { path: 'requests/new', component: RequestCreateComponent },
  { path: 'requests/:id/edit', component: RequestEditComponent },
  { path: 'companies/new', component: CompanyFormComponent },
];
