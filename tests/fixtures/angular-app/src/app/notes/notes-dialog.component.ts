import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NotesService } from './notes.service';

@Component({
  selector: 'app-notes-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './notes-dialog.component.html',
})
export class NotesDialogComponent {
  brouillon = '';

  constructor(private readonly notes: NotesService) {}

  fermer(): void {
    this.notes.fermer(this.brouillon);
  }
}
