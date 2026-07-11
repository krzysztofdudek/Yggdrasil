export function trace(prompt, response) {
  debugWrite(redactSecrets(prompt), response);
}
