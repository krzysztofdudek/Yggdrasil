# Markdown suppress fixture

A prose sentence mentioning yg-suppress(prose-aspect) mid-line is inert.

```ts
// yg-suppress(fenced-backtick) example inside a backtick fence
```

~~~
// yg-suppress(fenced-tilde) example inside a tilde fence
~~~

Text before an unclosed fence, which runs to end of file.

```
// yg-suppress(fenced-unclosed) example inside an unclosed fence to EOF
more fenced text with no closing delimiter
