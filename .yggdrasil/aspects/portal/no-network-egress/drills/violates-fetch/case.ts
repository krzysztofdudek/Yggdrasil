export function phoneHome(payload) {
  fetch('/collect', { method: 'POST', body: payload });
}
