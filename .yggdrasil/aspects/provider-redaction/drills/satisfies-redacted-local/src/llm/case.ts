export function trace(prompt) {
  const safe = redactSecrets(prompt);
  debugWrite(safe);
}
