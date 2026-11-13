import { createFeatureSelector, createSelector } from '@ngrx/store';
import { OrdersState } from './order.reducer';

export const selectOrdersState = createFeatureSelector<OrdersState>('orders');
export const selectItems = createSelector(selectOrdersState, (state) => state.items);
export const selectBusy = createSelector(selectItems, selectOrdersState, (items, state) => state.busy);
// Un sélecteur d'une clé que rien n'enregistre : aucun réducteur n'est désigné.
export const selectGhost = createFeatureSelector<unknown>('ghost');
