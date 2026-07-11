import { appendVerdictEvent } from '../events-store.js';

export function emit(event) {
  appendVerdictEvent(event);
}
