import { Component, Inject, inject } from '@angular/core';
import { Ledger, NOTIFIER, Notifier, PayGateway, WireGateway } from './pay.api';

@Component({ selector: 'app-c19', template: '<button (click)="pay()">Pay</button>' })
export class PayComponent {
  private readonly ledger = inject(Ledger);

  constructor(
    private gateway: PayGateway,
    @Inject(NOTIFIER) private notifier: Notifier,
  ) {}

  // Le fournisseur de la source dit quelle classe est injectée.
  pay(): void {
    this.gateway.pay().subscribe();
  }

  // Un jeton d'injection : la fabrique dit quelle classe est construite.
  notify(): void {
    this.notifier.notify().subscribe();
  }

  // Deux fournisseurs différents : les deux classes fournies restent candidates, la troisième jamais.
  record(): void {
    this.ledger.write().subscribe();
  }
}

// Le composant porte son propre fournisseur : il l'emporte sur celui de la source.
@Component({
  selector: 'app-c19-wire',
  template: '<button (click)="pay()">Pay</button><app-c19-child></app-c19-child>',
  providers: [{ provide: PayGateway, useClass: WireGateway }],
})
export class WirePayComponent {
  constructor(private gateway: PayGateway) {}

  pay(): void {
    this.gateway.pay().subscribe();
  }
}

// Affiché par le composant ci-dessus : il reçoit le fournisseur de son parent.
@Component({ selector: 'app-c19-child', template: '<button (click)="pay()">Pay</button>' })
export class WireChildComponent {
  constructor(private gateway: PayGateway) {}

  pay(): void {
    this.gateway.pay().subscribe();
  }
}
