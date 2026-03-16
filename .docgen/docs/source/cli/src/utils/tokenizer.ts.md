```markdown
# Tokenization Utility

## Overview
This module provides a function to tokenize text into meaningful words while filtering out stop words and ensuring uniqueness. It is designed for natural language processing tasks where noise reduction and normalization are essential.

## Purpose
The `tokenize` function processes input text to extract relevant tokens, removing common stop words and ensuring the output is a set of unique, lowercase words. It is particularly useful for text analysis, search indexing, and feature extraction.

## Usage

### Importing the Function
```typescript
import { tokenize } from './path/to/module';
```

### Example
```typescript
const text = "This is a sample sentence, demonstrating the tokenization process.";
const tokens = tokenize(text);
console.log(tokens); // Output: ['sample', 'sentence', 'demonstrating', 'tokenization', 'process']
```

## Behavior
1. **Text Normalization**: Converts the input text to lowercase to ensure consistency.
2. **Token Splitting**: Splits the text into tokens using non-alphanumeric characters as delimiters.
3. **Filtering**:
   - Removes tokens with fewer than 2 characters.
   - Excludes tokens present in the predefined `STOP_WORDS` set.
4. **Deduplication**: Returns a unique set of tokens using `Set`.

## Stop Words
The `STOP_WORDS` set contains common English words that are typically excluded from tokenization due to their lack of significance in text analysis. These include articles, pronouns, prepositions, and conjunctions.

## Notes
- The function assumes the input text is in English.
- Tokens are filtered based on length and stop word exclusion, ensuring only meaningful words are retained.
- The output is an array of unique tokens, preserving the order of first occurrence.
```