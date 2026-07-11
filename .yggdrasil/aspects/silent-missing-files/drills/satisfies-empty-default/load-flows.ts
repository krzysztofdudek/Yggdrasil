// Loads the optional flows/ directory from a graph root.
import { readdirSync } from 'node:fs';
import path from 'node:path';

interface Flow {
  name: string;
}

function parseFlow(file: string): Flow {
  return { name: file };
}

export function loadFlows(graphRoot: string): Flow[] {
  const flowsDir = path.join(graphRoot, 'flows');
  try {
    return readdirSync(flowsDir).map(parseFlow);
  } catch {
    return [];
  }
}
