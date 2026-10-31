import type { BookFormValues, CreateBookPayload } from './types.js';

export function toCreateBookPayload(values: BookFormValues): CreateBookPayload {
  const payload: CreateBookPayload = {
    title: values.title.trim(),
    isbn: values.isbn.replace(/-/g, ''),
  };
  // L'éditeur est facultatif : vide, il n'est pas envoyé.
  if (values.publisherId !== '') {
    payload.publisherId = Number(values.publisherId);
  }
  return payload;
}
