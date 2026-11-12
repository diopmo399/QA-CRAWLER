export type OrderAction =
  { type: 'LOAD' } | { type: 'SAVE'; title: string } | { type: 'VALIDATE'; title: string };
export interface OrderState {
  status: 'IDLE' | 'LOADED' | 'SAVED' | 'INVALID';
  items: { id: string; title: string }[];
}
