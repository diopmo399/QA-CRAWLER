import { Routes } from '@angular/router';
import { DossierListComponent } from './dossier/dossier-list.component';
import { DossierComponent } from './dossier/dossier.component';

export const routes: Routes = [
  { path: 'dossiers/nouveau', component: DossierComponent },
  { path: 'dossiers', component: DossierListComponent },
  { path: '', redirectTo: 'dossiers', pathMatch: 'full' },
];
