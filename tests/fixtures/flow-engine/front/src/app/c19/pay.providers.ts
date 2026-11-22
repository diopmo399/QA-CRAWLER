import { HTTP_INTERCEPTORS } from '@angular/common/http';
import {
  CardGateway,
  LocalLedger,
  Ledger,
  MailNotifier,
  NOTIFIER,
  PayGateway,
  RemoteLedger,
} from './pay.api';
import { PayAuthInterceptor } from './pay.interceptor';

export const payProviders = [
  { provide: PayGateway, useClass: CardGateway },
  { provide: NOTIFIER, useFactory: () => new MailNotifier(null as never) },
  { provide: HTTP_INTERCEPTORS, useClass: PayAuthInterceptor, multi: true },
];

// Deux configurations de l'application donnent chacune leur registre.
export const localProviders = [{ provide: Ledger, useClass: LocalLedger }];
export const remoteProviders = [{ provide: Ledger, useClass: RemoteLedger }];
