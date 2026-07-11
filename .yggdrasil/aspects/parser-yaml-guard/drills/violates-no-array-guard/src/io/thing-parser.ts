export function parse(text) {
  const raw = parseYaml(text);
  return raw.value;
}
