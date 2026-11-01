import type { BookView, CreateBookPayload } from './types.js';

const BOOKS_URL = '/api/books';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function createBook(payload: CreateBookPayload): Promise<BookView> {
  const response = await fetch('/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new ApiError(response.status, `L'enregistrement a échoué (HTTP ${response.status}).`);
  }
  return (await response.json()) as BookView;
}

export async function getBook(id: number): Promise<BookView> {
  const response = await fetch(`${BOOKS_URL}/${id}`);
  if (!response.ok) {
    throw new ApiError(response.status, `Livre introuvable (HTTP ${response.status}).`);
  }
  return (await response.json()) as BookView;
}
