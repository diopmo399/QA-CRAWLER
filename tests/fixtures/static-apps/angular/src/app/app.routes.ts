import { Routes } from '@angular/router';
import { DashboardComponent } from './dashboard/dashboard.component';
import { CreateUserComponent } from './users/create-user/create-user.component';
import { ContactsComponent } from './users/contacts/contacts.component';
import { UsersComponent } from './users/users.component';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'dashboard', component: DashboardComponent },
  {
    path: 'administration',
    canActivate: [authGuard],
    children: [
      { path: 'users', component: UsersComponent },
      { path: 'users/new', component: CreateUserComponent },
      { path: 'users/:id/contacts', component: ContactsComponent },
    ],
  },
  { path: 'reports', loadChildren: () => import('./reports/reports.routes').then((m) => m.REPORT_ROUTES) },
];
