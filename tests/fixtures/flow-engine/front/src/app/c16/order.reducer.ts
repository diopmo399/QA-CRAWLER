import { createReducer, on } from '@ngrx/store';
import { OrderPageActions, loadOrdersSuccess, saveOrder } from './order.actions';

export interface OrdersState {
  items: string[];
  busy: boolean;
}

const initialState: OrdersState = { items: [], busy: false };

export const ordersReducer = createReducer(
  initialState,
  on(loadOrdersSuccess, (state, { items }) => ({ ...state, items, busy: false })),
  on(saveOrder, OrderPageActions.removeOrder, (state) => ({ ...state, busy: true })),
);
