import { Component, Injector, inject } from '@angular/core';
import { StockApi, StockFactory, StockHelper } from './stock.api';

@Component({ selector: 'app-c20', template: '<button (click)="viaProperty()">Go</button>' })
export class StockComponent {
  // Une propriété au type écrit, affectée dans le constructeur sous un autre nom.
  private service!: StockApi;
  // Une propriété construite sur place.
  private readonly helper = new StockHelper(inject(StockApi));
  // Une propriété d'une bibliothèque : rien à suivre, rien à signaler.
  private readonly created = new Date();

  constructor(
    api: StockApi,
    private factory: StockFactory,
    private injector: Injector,
  ) {
    this.service = api;
  }

  // Un accesseur au type écrit.
  get lazy(): StockApi {
    return this.injector.get(StockApi);
  }

  viaProperty(): void {
    this.service.save().subscribe();
  }

  viaNew(): void {
    this.helper.refresh();
  }

  viaGetter(): void {
    this.lazy.remove().subscribe();
  }

  // Le retour d'une méthode d'une dépendance, par son type écrit.
  viaReturn(): void {
    this.factory.create().refresh();
  }

  // Une variable locale : injectée sur place, ou demandée à l'injecteur.
  viaLocal(): void {
    const api = inject(StockApi);
    api.save().subscribe();
    const other = this.injector.get(StockApi);
    other.remove().subscribe();
  }

  // Un retour inféré : rien d'écrit, le compilateur dit la classe.
  viaInferred(): void {
    const helper = this.factory.build();
    helper.refresh();
  }

  // L'élément d'une collection dont le type est inféré.
  viaLoop(): void {
    for (const helper of this.factory.all()) helper.refresh();
  }

  // `any` : le compilateur ne sait rien, rien n'est suivi.
  viaAny(): void {
    this.factory.loose().refresh();
  }

  viaLibrary(): number {
    return this.created.getTime();
  }
}
