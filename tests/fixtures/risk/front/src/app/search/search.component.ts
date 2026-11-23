import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subject, catchError, of, switchMap } from 'rxjs';
import { ApiService, Client } from '../api.service';

@Component({ selector: 'app-search', templateUrl: './search.component.html' })
export class SearchComponent implements OnInit {
  results: Client[] = [];
  fromRoute: Client[] = [];
  private readonly terms = new Subject<string>();
  /** Sûr : switchMap annule la requête précédente, l'erreur est rattrapée dans le flux interne. */
  readonly live$ = this.terms.pipe(switchMap((term) => this.api.search(term).pipe(catchError(() => of([])))));

  constructor(
    private api: ApiService,
    private route: ActivatedRoute,
  ) {}

  ngOnInit(): void {
    // Cas E : une requête par changement de paramètre, sans annuler la précédente.
    this.route.queryParams.subscribe((params) => {
      this.api.search(params['q']).subscribe((list) => (this.fromRoute = list));
    });
  }

  /** Cas E : chaque frappe lance une requête ; une réponse ancienne peut arriver après une récente. */
  search(term: string): void {
    this.api.search(term).subscribe((list) => (this.results = list));
  }

  /** Course : deux traitements écrivent `results` dans un ordre non maîtrisé. */
  refresh(): void {
    this.api.clients().subscribe((list) => (this.results = list));
  }

  type(term: string): void {
    this.terms.next(term);
  }
}
