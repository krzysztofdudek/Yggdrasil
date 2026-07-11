export function parse(text) {
  const raw = parseYaml(text);
  if (Array.isArray(raw)) throw new Error('array document not allowed');
  return raw.value;
}
