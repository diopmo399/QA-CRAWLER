import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodeSymbol } from '../../src/incident/model.js';
import { analyzeFrontendSource } from '../../src/incident/code/index.js';

/**
 * L'ANALYSE FRONTEND de l'Incident Reconstruction, par l'AST du compilateur TypeScript : le
 * formulaire « Nouveau livre » de la fixture (composant, gestionnaire `onSave`, validation,
 * transformation du payload qui écarte `publisherId`, appel `fetch`, `catch`), puis les autres
 * formes reconnues (axios, Angular, Vue, zod / yup, composants de classe, `.catch`).
 */

const BOOKS = path.resolve('tests/fixtures/incident-app/frontend/src/books');

function symbol(symbols: CodeSymbol[], name: string): CodeSymbol {
  const found = symbols.find((s) => s.name === name);
  if (!found)
    throw new Error(`symbole absent : ${name} (présents : ${symbols.map((s) => s.name).join(', ')})`);
  return found;
}

async function fixture(file: string): Promise<ReturnType<typeof analyzeFrontendSource>> {
  const text = await readFile(path.join(BOOKS, file), 'utf8');
  return analyzeFrontendSource('web', `frontend/src/books/${file}`, text);
}

describe('fixture : le formulaire « Nouveau livre »', () => {
  it('BookForm : composant, gestionnaire onSave relié au bouton Enregistrer, catch qui affiche un message', async () => {
    const result = await fixture('BookForm.tsx');
    const form = symbol(result.symbols, 'BookForm');
    expect(form).toMatchObject({ kind: 'COMPONENT', line: 14, layer: 'FRONTEND' });
    expect(form.id).toBe('web:frontend/src/books/BookForm.tsx#BookForm');
    const onSave = symbol(result.symbols, 'BookForm.onSave');
    expect(onSave).toMatchObject({ kind: 'EVENT_HANDLER', parent: form.id, line: 20 });
    expect(onSave.detail?.triggers).toEqual(['<form onSubmit> « Enregistrer »']);
    expect(onSave.detail?.imports).toEqual([
      'validateBook=./validation.js#validateBook',
      'isValidBook=./validation.js#isValidBook',
      'createBook=./books-api.js#createBook',
      'toCreateBookPayload=./payload.js#toCreateBookPayload',
    ]);
    const handler = symbol(result.symbols, 'BookForm.onSave.catch');
    expect(handler).toMatchObject({ kind: 'ERROR_HANDLER', parent: onSave.id });
    expect(handler.detail).toMatchObject({ rethrows: false, calls: ['setMessage'], style: 'try/catch' });
    // Les appels vers les imports du dépôt attendent resolveCalls ; ceux de react ne sont pas des relations.
    expect(result.calls.map((c) => `${c.status} ${c.text}`)).toEqual([
      'UNKNOWN validateBook(values)',
      'UNKNOWN isValidBook(found)',
      'UNKNOWN createBook(toCreateBookPayload(values))',
      'UNKNOWN toCreateBookPayload(values)',
    ]);
    expect(result.calls.every((c) => c.from === onSave.id)).toBe(true);
    // Les gestionnaires inline qui ne font que setValues ne deviennent pas des symboles.
    expect(result.symbols.filter((s) => s.kind === 'EVENT_HANDLER').map((s) => s.name)).toEqual([
      'BookForm.onSave',
    ]);
    expect(result.outgoing).toEqual([]);
  });

  it('payload : publisherId n’est envoyé que sous condition', async () => {
    const result = await fixture('payload.ts');
    expect(symbol(result.symbols, 'toCreateBookPayload')).toMatchObject({
      kind: 'PAYLOAD_TRANSFORM',
      line: 3,
      detail: {
        exported: true,
        fields: ['title', 'isbn', 'publisherId'],
        conditionalFields: ['publisherId'],
      },
    });
  });

  it('validation : les champs vérifiés (publisherId n’en fait pas partie)', async () => {
    const result = await fixture('validation.ts');
    expect(symbol(result.symbols, 'validateBook')).toMatchObject({
      kind: 'VALIDATION',
      detail: {
        checks: ['title', 'isbn'],
        messages: ['Le titre est obligatoire.', "L'ISBN n'est pas valide."],
      },
    });
    expect(symbol(result.symbols, 'isValidBook').kind).toBe('VALIDATION');
  });

  it('client : fetch littéral (STATICALLY_RESOLVED) et base constante du fichier (INFERRED)', async () => {
    const result = await fixture('books-api.ts');
    expect(result.outgoing.map((o) => `${o.status} ${o.method ?? '?'} ${o.path ?? '?'} ${o.line}`)).toEqual([
      'STATICALLY_RESOLVED POST /api/books 16',
      'INFERRED GET /api/books/{id} 28',
    ]);
    expect(symbol(result.symbols, 'createBook')).toMatchObject({
      kind: 'HTTP_CLIENT_CALL',
      detail: { http: ['POST /api/books'], throws: ['ApiError'], async: true },
    });
    expect(result.outgoing[0]?.symbolId).toBe('web:frontend/src/books/books-api.ts#createBook');
    expect(symbol(result.symbols, 'ApiError').kind).toBe('EXCEPTION');
    expect(result.outgoing.some((o) => o.status === 'OBSERVED')).toBe(false);
  });
});

describe('appels HTTP du frontend', () => {
  it('fetch : méthode par défaut, méthode non littérale, URL dynamique, base inconnue', () => {
    const result = analyzeFrontendSource(
      'web',
      'src/api.ts',
      `
      const API = '/api';
      const BOOKS = API + '/books';
      export function list() { return fetch(BOOKS); }
      export function save(book: { id: number }, method: string) {
        return fetch(\`\${BOOKS}/\${book.id}?draft=1\`, { method });
      }
      export function anywhere(url: string) { return fetch(url, { method: 'DELETE' }); }
      export function based(baseUrl: string, id: string) { return window.fetch(\`\${baseUrl}/books/\${encodeURIComponent(id)}\`); }
      export function weird(prefix: string) { return fetch(prefix + 'books'); }
    `,
    );
    expect(result.outgoing.map((o) => `${o.status} ${o.method ?? '?'} ${o.path ?? '?'}`)).toEqual([
      'INFERRED GET /api/books',
      'INFERRED ? /api/books/{id}',
      'UNKNOWN DELETE ?',
      'INFERRED GET /books/{id}',
      'UNKNOWN GET ?',
    ]);
  });

  it('axios : verbes, configuration objet, instance axios.create avec baseURL', () => {
    const result = analyzeFrontendSource(
      'web',
      'src/books.service.js',
      `
      import axios from 'axios';
      const api = axios.create({ baseURL: '/api' });
      export const getAll = () => axios.get('/api/books');
      export async function create(book) { return (await api.post('/books', book)).data; }
      export function update(id, book) { return axios({ method: 'put', url: \`/api/books/\${id}\`, data: book }); }
      export function remove(id) { return api.delete(\`/books/\${id}\`).catch((e) => console.error(e)); }
    `,
    );
    expect(result.outgoing.map((o) => `${o.status} ${o.method ?? '?'} ${o.path ?? '?'}`)).toEqual([
      'STATICALLY_RESOLVED GET /api/books',
      'INFERRED POST /api/books',
      'STATICALLY_RESOLVED PUT /api/books/{id}',
      'INFERRED DELETE /api/books/{id}',
    ]);
    expect(symbol(result.symbols, 'remove.catch')).toMatchObject({
      kind: 'ERROR_HANDLER',
      detail: { style: '.catch()', calls: ['console.error'] },
    });
  });

  it('Angular : composant décoré, service HttpClient injecté, appel vers le service', () => {
    const service = analyzeFrontendSource(
      'web',
      'src/app/book.service.ts',
      `
      import { Injectable } from '@angular/core';
      import { HttpClient } from '@angular/common/http';
      @Injectable({ providedIn: 'root' })
      export class BookService {
        private readonly base = '/api/books';
        constructor(private http: HttpClient) {}
        create(book: Book) { return this.http.post<Book>('/api/books', book); }
        find(id: number) { return this.http.request('GET', \`/api/books/\${id}\`); }
      }
    `,
    );
    expect(symbol(service.symbols, 'BookService')).toMatchObject({
      kind: 'HTTP_CLIENT',
      detail: { declaration: 'class', fields: ['http:HttpClient'] },
    });
    expect(
      service.outgoing.map(
        (o) => `${o.status} ${o.method ?? '?'} ${o.path ?? '?'} ${o.symbolId.split('#')[1] ?? ''}`,
      ),
    ).toEqual([
      'STATICALLY_RESOLVED POST /api/books BookService.create',
      'STATICALLY_RESOLVED GET /api/books/{id} BookService.find',
    ]);
    const component = analyzeFrontendSource(
      'web',
      'src/app/book-form.component.ts',
      `
      import { Component } from '@angular/core';
      import { BookService } from './book.service';
      @Component({ selector: 'app-book-form', templateUrl: './book-form.component.html' })
      export class BookFormComponent {
        constructor(private readonly books: BookService) {}
        onSubmit() { this.validate(); this.books.create(this.form.value).subscribe({ error: () => this.failed() }); }
        validate() { return true; }
        failed() {}
      }
    `,
    );
    expect(symbol(component.symbols, 'BookFormComponent')).toMatchObject({
      kind: 'COMPONENT',
      detail: {
        framework: 'angular',
        selector: 'app-book-form',
        imports: ['BookService=./book.service#BookService'],
      },
    });
    expect(symbol(component.symbols, 'BookFormComponent.onSubmit').kind).toBe('EVENT_HANDLER');
    expect(symbol(component.symbols, 'BookFormComponent.validate').kind).toBe('VALIDATION');
    expect(component.calls.map((c) => `${c.status} ${c.text}`)).toEqual([
      'STATICALLY_RESOLVED this.validate()',
      'UNKNOWN this.books.create(this.form.value)',
      'STATICALLY_RESOLVED this.failed()',
    ]);
  });

  it('Vue : <script setup> et API options (defineComponent), gestionnaires du template', () => {
    const setup = analyzeFrontendSource(
      'web',
      'src/components/BookEditor.vue',
      `<template>
  <form @submit.prevent="save"><button>Enregistrer</button></form>
</template>
<script setup lang="ts">
import { createBook } from '../books/books-api';
function save() {
  return createBook({ title: 'x', isbn: 'y' });
}
</script>`,
    );
    expect(symbol(setup.symbols, 'BookEditor')).toMatchObject({
      kind: 'COMPONENT',
      detail: { framework: 'vue' },
    });
    expect(symbol(setup.symbols, 'BookEditor.save')).toMatchObject({
      kind: 'EVENT_HANDLER',
      line: 6,
      detail: { triggers: ['@submit.prevent (template)'] },
    });
    expect(setup.calls.map((c) => `${c.status} ${c.text}`)).toEqual([
      "UNKNOWN createBook({ title: 'x', isbn: 'y' })",
    ]);
    const options = analyzeFrontendSource(
      'web',
      'src/components/BookList.vue',
      `<script>
import { defineComponent } from 'vue';
import axios from 'axios';
export default defineComponent({
  name: 'BookList',
  methods: {
    handleRefresh() { return axios.get('/api/books'); },
    mapRows(rows) { return rows; },
  },
});
</script>`,
    );
    expect(symbol(options.symbols, 'BookList').kind).toBe('COMPONENT');
    expect(symbol(options.symbols, 'BookList.handleRefresh').kind).toBe('EVENT_HANDLER');
    expect(symbol(options.symbols, 'BookList.mapRows').kind).toBe('PAYLOAD_TRANSFORM');
    expect(options.outgoing[0]).toMatchObject({ method: 'GET', path: '/api/books', line: 7 });
  });
});

describe('composants et validations', () => {
  it('composant de classe React, gestionnaires et appel d’une fonction du fichier déclarée plus bas', () => {
    const result = analyzeFrontendSource(
      'web',
      'src/BookList.jsx',
      `
      import React from 'react';
      export default class BookList extends React.Component {
        handleClick = () => { this.props.onPick(serializeBook(this.props.book)); };
        render() { return <button onClick={this.handleClick}>Choisir</button>; }
      }
      function serializeBook(book) { return { id: book.id }; }
    `,
    );
    expect(symbol(result.symbols, 'BookList')).toMatchObject({
      kind: 'COMPONENT',
      detail: { framework: 'react', exportDefault: true },
    });
    expect(symbol(result.symbols, 'BookList.handleClick')).toMatchObject({
      kind: 'EVENT_HANDLER',
      detail: { triggers: ['<button onClick> « Choisir »'] },
    });
    expect(symbol(result.symbols, 'serializeBook').kind).toBe('PAYLOAD_TRANSFORM');
    expect(result.calls).toEqual([
      expect.objectContaining({
        from: 'web:src/BookList.jsx#BookList.handleClick',
        to: 'web:src/BookList.jsx#serializeBook',
        status: 'STATICALLY_RESOLVED',
      }),
    ]);
  });

  it('gestionnaire inline qui appelle un import : un symbole EVENT_HANDLER', () => {
    const result = analyzeFrontendSource(
      'web',
      'src/Remove.tsx',
      `
      import { removeBook } from './api';
      export const Remove = ({ id }: { id: number }) => (
        <button type="button" onClick={() => removeBook(id)}>Supprimer</button>
      );
    `,
    );
    expect(symbol(result.symbols, 'Remove').kind).toBe('COMPONENT');
    expect(symbol(result.symbols, 'Remove.button.onClick')).toMatchObject({
      kind: 'EVENT_HANDLER',
      detail: { inline: true, triggers: ['<button onClick> « Supprimer »'] },
    });
    expect(result.calls[0]).toMatchObject({
      from: 'web:src/Remove.tsx#Remove.button.onClick',
      text: 'removeBook(id)',
    });
  });

  it('schémas zod et yup : champs requis et facultatifs', () => {
    const result = analyzeFrontendSource(
      'web',
      'src/schemas.ts',
      `
      import { z } from 'zod';
      import * as yup from 'yup';
      export const bookSchema = z.object({
        title: z.string().min(1),
        isbn: z.string().regex(/^\\d{13}$/),
        publisherId: z.number().optional(),
      });
      export const authorSchema = yup.object({ name: yup.string().required(), bio: yup.string() });
    `,
    );
    expect(symbol(result.symbols, 'bookSchema')).toMatchObject({
      kind: 'VALIDATION',
      detail: {
        schema: 'zod',
        fields: ['title', 'isbn', 'publisherId'],
        requiredFields: ['title', 'isbn'],
        optionalFields: ['publisherId'],
        validations: ['title: string.min', 'isbn: string.regex', 'publisherId: number.optional'],
      },
    });
    expect(symbol(result.symbols, 'authorSchema').detail).toMatchObject({
      schema: 'yup',
      requiredFields: ['name'],
      optionalFields: ['bio'],
    });
  });

  it('un source invalide ne lève jamais d’exception', () => {
    expect(() =>
      analyzeFrontendSource('web', 'src/broken.tsx', 'export function ( { <div> fetch('),
    ).not.toThrow();
  });
});
