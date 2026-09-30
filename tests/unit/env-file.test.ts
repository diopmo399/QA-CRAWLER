import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvFileError, loadEnvFile, parseEnvText, takeEnvFileOption } from '../../src/cli/env-file.js';

describe('.env file', () => {
  it('reads NAME=value, comments, quotes, export', () => {
    expect(
      parseEnvText(
        [
          '# identifiants de test',
          'QA_USERNAME=utilisateur',
          'export QA_BASE_URL=https://qa.example.com # commentaire',
          `QA_PASSWORD='mot de passe # avec dièse'`,
          'QA_NOTE="ligne 1\\nligne 2 \\"citée\\""',
          '',
          'VIDE=',
        ].join('\r\n'),
      ),
    ).toEqual({
      QA_USERNAME: 'utilisateur',
      QA_BASE_URL: 'https://qa.example.com',
      QA_PASSWORD: 'mot de passe # avec dièse',
      QA_NOTE: 'ligne 1\nligne 2 "citée"',
      VIDE: '',
    });
  });

  it('an invalid line is an error with its number, never its value', () => {
    expect(() => parseEnvText('A=1\nnot a variable secret123', 'mine.env')).toThrow(
      /^mine\.env:2: expected NAME=value$/,
    );
    expect(() => parseEnvText(`B="secret123`)).toThrow(/missing closing quote for B$/);
  });

  it('.env of the current folder by default; the terminal wins; nothing without a file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-env-'));
    expect(loadEnvFile(undefined, {}, dir)).toEqual({ loaded: [], kept: [] });
    await writeFile(path.join(dir, '.env'), 'QA_USERNAME=du-fichier\nQA_PASSWORD=secret\n');
    const env: NodeJS.ProcessEnv = { QA_USERNAME: 'du-terminal' };
    const result = loadEnvFile(undefined, env, dir);
    expect(result).toMatchObject({ loaded: ['QA_PASSWORD'], kept: ['QA_USERNAME'] });
    expect(env).toEqual({ QA_USERNAME: 'du-terminal', QA_PASSWORD: 'secret' });
  });

  it('--dotenv: another file, required when given, removed from the arguments', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-env-'));
    await writeFile(path.join(dir, '.env.qa'), 'QA_BASE_URL=https://qa.example.com\n');
    expect(takeEnvFileOption(['dry-run', 'a.feature', '--dotenv', '.env.qa', '-q'])).toEqual({
      argv: ['dry-run', 'a.feature', '-q'],
      envFile: '.env.qa',
    });
    expect(takeEnvFileOption(['--dotenv=.env.qa', 'mission.yaml']).envFile).toBe('.env.qa');
    expect(() => takeEnvFileOption(['--dotenv'])).toThrow(EnvFileError);
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile('.env.qa', env, dir);
    expect(env.QA_BASE_URL).toBe('https://qa.example.com');
    expect(() => loadEnvFile('absent.env', {}, dir)).toThrow(/env file not found: absent\.env/);
  });
});
