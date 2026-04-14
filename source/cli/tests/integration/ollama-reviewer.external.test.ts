import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../../src/llm/ollama.js';

describe('Ollama integration (requires running Ollama)', () => {
  const endpoint = process.env.OLLAMA_ENDPOINT ?? 'http://host.docker.internal:11434';
  const model = process.env.OLLAMA_MODEL ?? 'gemma4:e4b';

  it('verifies a simple aspect against source code', async () => {
    const provider = new OllamaProvider({
      provider: 'ollama', model, endpoint, temperature: 0,
      consensus: 1, max_tokens: 'auto',
    });

    const prompt = `<task>
You verify whether source code satisfies a requirement.

Below is a node (component) with its source files and one aspect (rule set).
Check every rule in the aspect against the source code.

Respond with EXACTLY this JSON, nothing else:
{"satisfied": true|false, "reason": "explanation"}
</task>

<node path="test/example" description="Example module" />

<aspect id="no-var" description="No var declarations">
Source code must not use var keyword. Use const or let instead.
</aspect>

<source-files>
<file path="example.ts">
const x = 1;
let y = 2;
</file>
</source-files>`;

    const result = await provider.verifyAspect(prompt);
    expect(result.satisfied).toBe(true);
  }, 30_000);

  it('detects aspect violation', async () => {
    const provider = new OllamaProvider({
      provider: 'ollama', model, endpoint, temperature: 0,
      consensus: 1, max_tokens: 'auto',
    });

    const prompt = `<task>
You verify whether source code satisfies a requirement.

Below is a node (component) with its source files and one aspect (rule set).
Check every rule in the aspect against the source code.

Respond with EXACTLY this JSON, nothing else:
{"satisfied": true|false, "reason": "explanation"}
</task>

<node path="test/example" description="Example module" />

<aspect id="no-var" description="No var declarations">
Source code must not use var keyword. Use const or let instead.
</aspect>

<source-files>
<file path="example.ts">
var x = 1;
var y = 2;
</file>
</source-files>`;

    const result = await provider.verifyAspect(prompt);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBeTruthy();
  }, 30_000);
});
