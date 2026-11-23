import { Routes } from '@angular/router';
import { ClientListComponent } from './clients/client-list.component';
import { ClientDetailComponent } from './clients/client-detail.component';
import { ContratComponent } from './clients/contrat.component';
import { OrderPageComponent } from './orders/order-page.component';
import { SearchComponent } from './search/search.component';
import { DossierComponent } from './dossier/dossier.component';
import { LeakyComponent } from './board/leaky.component';
import { SafeComponent } from './board/safe.component';
import { PrefsComponent } from './prefs/prefs.component';
import { WorkshopComponent } from './workshop/workshop.component';

export const routes: Routes = [
  { path: 'clients', component: ClientListComponent },
  { path: 'clients/:id', component: ClientDetailComponent },
  { path: 'contrats', component: ContratComponent },
  { path: 'commandes', component: OrderPageComponent },
  { path: 'recherche', component: SearchComponent },
  { path: 'dossier', component: DossierComponent },
  { path: 'tableau', component: LeakyComponent },
  { path: 'apercu', component: SafeComponent },
  { path: 'preferences', component: PrefsComponent },
  { path: 'atelier', component: WorkshopComponent },
];
