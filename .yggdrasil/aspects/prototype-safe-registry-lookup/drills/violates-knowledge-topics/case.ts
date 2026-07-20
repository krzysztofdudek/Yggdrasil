// Reproduces the KNOWLEDGE_TOPICS bug in same-file form: a runtime key is looked
// up in a string-keyed object-literal registry, then existence-checked against
// `undefined` — which an inherited Object.prototype key (e.g. 'constructor')
// silently bypasses.
interface Topic {
  title: string;
  body: string;
}

const KNOWLEDGE_TOPICS: Record<string, Topic> = {
  onboarding: { title: 'Onboarding', body: 'How to start.' },
  flows: { title: 'Flows', body: 'Business processes.' },
};

export function readTopic(name: string): string {
  const topic = KNOWLEDGE_TOPICS[name];
  if (topic === undefined) return 'unknown topic';
  return topic.body;
}
