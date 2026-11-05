import { Routes } from '@angular/router';
import { DossierComponent } from './dossier/dossier.component';
import { HistoryComponent } from './dossier/history.component';

export const routes: Routes = [
  {
    path: 'dossier',
    component: DossierComponent,
    children: [{ path: 'history', component: HistoryComponent }],
  },
];
