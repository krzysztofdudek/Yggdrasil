---
id: javascript-jsx-in-js-edge
language: javascript
category: import
expectation: edge
cites: "React — JSX in `.js` files (the JavaScript grammar parses JSX)"
---

## Rule

A `.js` file that contains JSX parses with the JavaScript grammar, which includes JSX, and its imports resolve normally, including an extensionless specifier probing `.jsx`.

## Files

```js path=r/b/Button.jsx
export default function Button() { return null; }
```

```js path=r/app/View.js
import Button from '../b/Button';
export const View = () => <Button />;
```

## Expect

- r/app/View.js:1 -> node:b      # extensionless → Button.jsx
