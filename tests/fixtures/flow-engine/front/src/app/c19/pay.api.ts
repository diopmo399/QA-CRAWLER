import { HttpClient } from '@angular/common/http';
import { Injectable, InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

// Un type abstrait : deux classes le réalisent.
export abstract class PayGateway {
  abstract pay(): Observable<void>;
}

@Injectable()
export class CardGateway extends PayGateway {
  constructor(private http: HttpClient) {
    super();
  }

  pay(): Observable<void> {
    return this.http.post<void>('/api/c19/card', {});
  }
}

@Injectable()
export class WireGateway extends PayGateway {
  constructor(private http: HttpClient) {
    super();
  }

  pay(): Observable<void> {
    return this.http.post<void>('/api/c19/wire', {});
  }
}

// Une interface et son jeton : rien n'est une classe ici.
export interface Notifier {
  notify(): Observable<void>;
}
export const NOTIFIER = new InjectionToken<Notifier>('notifier');

@Injectable()
export class MailNotifier implements Notifier {
  constructor(private http: HttpClient) {}

  notify(): Observable<void> {
    return this.http.post<void>('/api/c19/mail', {});
  }
}

// Un type que deux fournisseurs réalisent différemment, sans rien pour les départager.
export abstract class Ledger {
  abstract write(): Observable<void>;
}

@Injectable()
export class LocalLedger extends Ledger {
  constructor(private http: HttpClient) {
    super();
  }

  write(): Observable<void> {
    return this.http.post<void>('/api/c19/ledger/local', {});
  }
}

@Injectable()
export class RemoteLedger extends Ledger {
  constructor(private http: HttpClient) {
    super();
  }

  write(): Observable<void> {
    return this.http.post<void>('/api/c19/ledger/remote', {});
  }
}

@Injectable()
export class ArchiveLedger extends Ledger {
  constructor(private http: HttpClient) {
    super();
  }

  write(): Observable<void> {
    return this.http.post<void>('/api/c19/ledger/archive', {});
  }
}
