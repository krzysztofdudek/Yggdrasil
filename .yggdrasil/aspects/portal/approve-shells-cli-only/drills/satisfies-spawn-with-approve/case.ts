import { spawnSync } from 'node:child_process';

export function approve(bin) {
  spawnSync(bin, ['check', '--approve', '--only-deterministic']);
}
