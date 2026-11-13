import { provideState, provideStore } from '@ngrx/store';
import { ordersReducer } from './order.reducer';

export const orderProviders = [provideStore(), provideState('orders', ordersReducer)];
