import type { BookFormValues, ValidationErrors } from './types.js';

const ISBN = /^(97[89])?\d{9}[\dX]$/;

export function validateBook(values: BookFormValues): ValidationErrors {
  const errors: ValidationErrors = {};
  if (values.title.trim() === '') errors.title = 'Le titre est obligatoire.';
  if (!ISBN.test(values.isbn.replace(/-/g, ''))) errors.isbn = "L'ISBN n'est pas valide.";
  return errors;
}

export function isValidBook(errors: ValidationErrors): boolean {
  return Object.keys(errors).length === 0;
}
