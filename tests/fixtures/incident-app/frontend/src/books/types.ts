/** Les valeurs du formulaire « Nouveau livre » (les champs HTML sont des chaînes). */
export interface BookFormValues {
  title: string;
  isbn: string;
  /** L'identifiant de l'éditeur choisi dans la liste ; vide tant qu'aucun n'est choisi. */
  publisherId: string;
}

export interface CreateBookPayload {
  title: string;
  isbn: string;
  publisherId?: number;
}

export interface BookView {
  id: number;
  title: string;
  isbn: string;
  publisherName: string;
}

export interface PublisherOption {
  id: number;
  name: string;
}

export interface ValidationErrors {
  title?: string;
  isbn?: string;
}
