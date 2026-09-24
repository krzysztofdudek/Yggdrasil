import { textFillSink } from '../formatters/fill-text.js';

export const sink = textFillSink(process.stderr.write.bind(process.stderr));
