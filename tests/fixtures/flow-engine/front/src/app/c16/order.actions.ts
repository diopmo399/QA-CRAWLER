import { createAction, createActionGroup, emptyProps, props } from '@ngrx/store';

export const loadOrders = createAction('[Orders] Load');
export const loadOrdersSuccess = createAction('[Orders] Load Success', props<{ items: string[] }>());
export const saveOrder = createAction('[Orders] Save', props<{ id: string }>());

export const OrderPageActions = createActionGroup({
  source: 'Order Page',
  events: {
    'Remove Order': props<{ id: string }>(),
    'Order Removed': emptyProps(),
    Opened: emptyProps(),
  },
});
