import { spawnSync } from 'node:child_process';

export function approve(bin) {
  spawnSync(bin, ['check', '--only-deterministic']);
}
