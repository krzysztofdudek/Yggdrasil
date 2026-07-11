// Reads a config file, falling back to defaults when the read or parse fails.
import { readFileSync } from 'node:fs';

interface Config {
  name: string;
}

function parseConfig(text: string): Config {
  return JSON.parse(text) as Config;
}

function defaultConfig(): Config {
  return { name: 'default' };
}

export function readConfigOrDefault(filePath: string): Config {
  try {
    return parseConfig(readFileSync(filePath, 'utf8'));
  } catch {
    return defaultConfig();
  }
}
