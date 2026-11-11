import { Routes } from '@angular/router';
import { OrdersComponent } from './orders/orders.component';
import { ListComponent as AdminList } from './admin/list/list.component';
import { ListComponent as CatalogList } from './catalog/list/list.component';
// Un composant dont le fichier n'est pas dans la source : la route reste, sa relation est gardée non résolue.
import { LegacyComponent } from './legacy/legacy.component';

export const routes: Routes = [
  { path: 'orders', component: OrdersComponent },
  { path: 'admin', component: AdminList },
  { path: 'catalog', component: CatalogList },
  { path: 'legacy', component: LegacyComponent },
];
