import { Routes } from '@angular/router';
import { AccountFormComponent } from './accounts/account-form.component';

export const routes: Routes = [
  { path: '', redirectTo: 'accounts/new', pathMatch: 'full' },
  { path: 'accounts/new', component: AccountFormComponent },
];
