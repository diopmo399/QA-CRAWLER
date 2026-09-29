import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonPersistenceProvider } from '../../src/persistence/file/json-provider.js';
import { InMemoryPersistenceProvider } from '../../src/persistence/memory/in-memory-provider.js';
import { persistenceProviderContract } from '../persistence/provider-contract.js';

persistenceProviderContract('in-memory', { create: () => new InMemoryPersistenceProvider(), durable: false });

const directory = mkdtempSync(path.join(tmpdir(), 'qa-persistence-json-'));
persistenceProviderContract('file (JSON)', {
  create: () => new JsonPersistenceProvider(directory),
  durable: true,
});
