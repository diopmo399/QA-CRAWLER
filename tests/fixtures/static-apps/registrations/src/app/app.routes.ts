import { Routes } from '@angular/router';
import { RegistrationDetailComponent } from './registrations/registration-detail.component';
import { RegistrationsComponent } from './registrations/registrations.component';
import { UserFormComponent } from './users/user-form.component';
import { UsersComponent } from './users/users.component';

export const routes: Routes = [
  { path: '', redirectTo: 'registrations', pathMatch: 'full' },
  { path: 'registrations', component: RegistrationsComponent },
  { path: 'registrations/:id', component: RegistrationDetailComponent },
  { path: 'users', component: UsersComponent },
  { path: 'users/new', component: UserFormComponent },
];
