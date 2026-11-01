import { useState, type FormEvent } from 'react';
import { createBook } from './books-api.js';
import { toCreateBookPayload } from './payload.js';
import type { BookFormValues, BookView, PublisherOption, ValidationErrors } from './types.js';
import { isValidBook, validateBook } from './validation.js';

const EMPTY: BookFormValues = { title: '', isbn: '', publisherId: '' };

interface BookFormProps {
  publishers: PublisherOption[];
  onCreated: (book: BookView) => void;
}

export function BookForm({ publishers, onCreated }: BookFormProps) {
  const [values, setValues] = useState<BookFormValues>(EMPTY);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateBook(values);
    setErrors(found);
    if (!isValidBook(found)) return;
    setSaving(true);
    try {
      const book = await createBook(toCreateBookPayload(values));
      setMessage(`Livre « ${book.title} » enregistré.`);
      setValues(EMPTY);
      onCreated(book);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erreur inattendue.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSave} aria-label="Nouveau livre">
      <label>
        Titre
        <input value={values.title} onChange={(e) => setValues({ ...values, title: e.target.value })} />
      </label>
      {errors.title && <p className="error">{errors.title}</p>}
      <label>
        ISBN
        <input value={values.isbn} onChange={(e) => setValues({ ...values, isbn: e.target.value })} />
      </label>
      {errors.isbn && <p className="error">{errors.isbn}</p>}
      <label>
        Éditeur
        <select
          value={values.publisherId}
          onChange={(e) => setValues({ ...values, publisherId: e.target.value })}
        >
          <option value="">— Aucun éditeur —</option>
          {publishers.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={saving}>
        Enregistrer
      </button>
      {message && <p role="alert">{message}</p>}
    </form>
  );
}
