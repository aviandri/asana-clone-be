import { readFileSync } from 'node:fs';

/** The BE's version (package.json), reported by /mcp's server info. */
export const APP_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();
