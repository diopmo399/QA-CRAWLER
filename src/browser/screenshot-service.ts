import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { effectivePath } from '../crawler/url-normalizer.js';

/** Fichiers produits par ce service : 001-home.png, 012-admin-users-error.png… */
const SCREENSHOT_FILE = /^\d{3,}-[a-z0-9-]*\.png$/;

export class ScreenshotService {
  constructor(
    private readonly directory: string,
    private readonly fullPage: boolean,
  ) {}

  /** Crée le dossier et supprime les captures d'un run précédent (seulement les fichiers qui suivent notre nommage). */
  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) {
      if (SCREENSHOT_FILE.test(file)) await rm(path.join(this.directory, file), { force: true });
    }
  }

  /** Capture nommée d'après le libellé d'un état ; undefined quand la page n'a pas pu être capturée. */
  async captureState(
    page: Page,
    sequence: number,
    label: string,
    suffix?: string,
  ): Promise<string | undefined> {
    return this.write(page, stateScreenshotFileName(sequence, label, suffix));
  }

  /** Renvoie le chemin du fichier, ou undefined quand la page n'a pas pu être capturée (fermée, plantée…). */
  async capture(page: Page, sequence: number, url: string, suffix?: string): Promise<string | undefined> {
    return this.write(page, screenshotFileName(sequence, url, suffix));
  }

  private async write(page: Page, file: string): Promise<string | undefined> {
    const target = path.join(this.directory, file);
    try {
      await page.screenshot({
        path: target,
        fullPage: this.fullPage,
        timeout: 10_000,
        animations: 'disabled',
      });
      return target;
    } catch {
      return undefined;
    }
  }
}

/** Nom de fichier sûr et triable pour un état : (3, "Users list", "error") → "003-users-list-error.png". */
export function stateScreenshotFileName(sequence: number, label: string, suffix?: string): string {
  const slug =
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'state';
  const safeSuffix = suffix ? `-${suffix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
  return `${String(sequence).padStart(3, '0')}-${slug}${safeSuffix}.png`;
}

/** Nom de fichier sûr et triable tiré du chemin de la page : 3 → "003-admin-users-error.png". */
export function screenshotFileName(sequence: number, url: string, suffix?: string): string {
  let pagePath = '/';
  try {
    pagePath = effectivePath(url);
    pagePath = decodeURIComponent(pagePath);
  } catch {
    // on garde ce qu'on a : le slug ci-dessous ne garde que [a-z0-9-]
  }
  const slug =
    pagePath
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'home';
  const safeSuffix = suffix ? `-${suffix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
  return `${String(sequence).padStart(3, '0')}-${slug}${safeSuffix}.png`;
}
