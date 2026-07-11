export function trace(prompt) {
  debugWrite(redactSecrets(prompt));
}
