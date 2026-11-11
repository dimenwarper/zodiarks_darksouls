import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Read an API key from the environment, falling back to its export line in ~/.bash_profile. */
export function apiKey(name) {
  if (process.env[name]) return process.env[name];
  const profile = join(homedir(), '.bash_profile');
  if (existsSync(profile)) {
    const m = readFileSync(profile, 'utf8').match(new RegExp(`^export ${name}=["']?([^"'\\s]+)`, 'm'));
    if (m) return m[1];
  }
  console.error(`${name} is not set (environment or ~/.bash_profile)`);
  process.exit(1);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
