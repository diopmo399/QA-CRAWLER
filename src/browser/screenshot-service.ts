import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { effectivePath } from '../crawler/url-normalizer.js';

/** Files produced by this service: 001-home.png, 012-admin-users-error.png… */
const SCREENSHOT_FILE = /^\d{3,}-[a-z0-9-]*\.png$/;

export class ScreenshotService {
  constructor(
    private readonly directory: string,
    private readonly fullPage: boolean,
  ) {}

  /** Creates the directory and removes screenshots left by a previous run (only files matching our naming scheme). */
  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) {
      if (SCREENSHOT_FILE.test(file)) await rm(path.join(this.directory, file), { force: true });
    }
  }

  /** Returns the file path, or undefined when the page could not be captured (closed, crashed…). */
  async capture(page: Page, sequence: number, url: string, suffix?: string): Promise<string | undefined> {
    const file = screenshotFileName(sequence, url, suffix);
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

/** Safe, sortable file name derived from the page path: 3 → "003-admin-users-error.png". */
export function screenshotFileName(sequence: number, url: string, suffix?: string): string {
  let pagePath = '/';
  try {
    pagePath = effectivePath(url);
    pagePath = decodeURIComponent(pagePath);
  } catch {
    // keep what we have: the slug below only keeps [a-z0-9-]
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
