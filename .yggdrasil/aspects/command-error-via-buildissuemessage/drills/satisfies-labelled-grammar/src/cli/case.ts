import { count, field, heading, next, note } from './output.js';

// A finding in the one grammar: heading, labelled fields, a counted noun, and
// the step to take — every label lowercase, every word from the output layer.
export function renderFinding(files: string[], why: string, fix: string): string {
  return [
    heading('warning', 'uncovered', `${count(files.length, 'file')} belong to no node`),
    ...field('at', files),
    ...field('why', why),
    ...field('fix', fix),
    '',
    note('Nothing is required to be covered.'),
    next(`yg type-suggest --file ${files[0]}`),
  ].join('\n');
}
