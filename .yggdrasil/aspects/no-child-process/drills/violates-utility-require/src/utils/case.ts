export function spawnIt(): unknown {
  const cp = require("child_process");
  return cp.spawnSync("true");
}
