import { Component } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { NotesDialogComponent } from '../notes/notes-dialog.component';
import { NotesService } from '../notes/notes.service';
import { BusyService } from '../shared/busy.service';
import { DossierApiService } from './dossier-api.service';

@Component({
  selector: 'app-dossier',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, NotesDialogComponent],
  templateUrl: './dossier.component.html',
})
export class DossierComponent {
  readonly form = this.fb.group({
    code: ['', Validators.required],
    titre: [''],
    categorie: ['courant'],
    urgent: [false],
  });
  statut = '';
  erreur = '';
  notesOuvertes = false;
  aideOuverte = false;

  constructor(
    private readonly fb: FormBuilder,
    readonly busy: BusyService,
    private readonly api: DossierApiService,
    private readonly notes: NotesService,
  ) {
    this.notes.ouvert$.subscribe((ouvert) => (this.notesOuvertes = ouvert));
  }

  enregistrer(): void {
    if (this.busy.locked) return;
    this.busy.lock();
    const code = (this.form.value.code ?? '').trim();
    const notes = this.notes.dernierBrouillon();
    if (!code && !notes) {
      this.busy.unlock();
      this.erreur = 'Le code est requis';
      return;
    }
    // Le code manquant est déduit du premier mot du brouillon : rien ne protège le cas du brouillon vide.
    const libelle = code || notes!.brouillon.match(/^[A-Za-z0-9-]+/)![0];
    this.statut = 'Enregistrement…';
    this.api.creer({ ...this.form.getRawValue(), code: libelle } as never).subscribe({
      next: () => {
        this.statut = 'Dossier créé';
        this.busy.unlock();
      },
      error: () => {
        this.erreur = "Le dossier n'a pas été enregistré";
        this.busy.unlock();
      },
    });
  }

  actualiser(): void {
    if (this.busy.locked) return;
    this.busy.lock();
    this.api.recents().subscribe((dossiers) => {
      this.statut = `${dossiers.length} dossier(s) récent(s)`;
      this.busy.unlock();
    });
  }

  ouvrirNotes(): void {
    if (this.busy.locked) return;
    this.notes.ouvrir();
  }

  ouvrirAide(): void {
    this.aideOuverte = true;
  }

  fermerAide(): void {
    this.aideOuverte = false;
  }
}
