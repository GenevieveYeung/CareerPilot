import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requested = process.env.PLAYWRIGHT_MODULE;
const moduleUrl = requested && (path.isAbsolute(requested) || requested.startsWith('.'))
  ? pathToFileURL(path.resolve(requested)).href
  : (requested || 'playwright');

export const { chromium } = await import(moduleUrl);
