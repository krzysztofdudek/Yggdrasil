// Reads the application's configuration.
import fs from 'node:fs';

export interface Config {
  port: number;
}

const DEFAULTS: Config = { port: 8080 };

export function readConfig(path: string): Config {
  // Read once at startup.
  const text = fs.readFileSync(path, 'utf-8');
  return { ...DEFAULTS, ...JSON.parse(text) };
}
