/**
 * Structured issue message for CLI output.
 * Every diagnostic message follows: what happened → why it's a problem → next command.
 */
export interface IssueMessage {
  /** What happened — facts, one line or short block */
  what: string;
  /** Why it's a problem — context for the agent */
  why: string;
  /** Concrete command or instruction to resolve */
  next: string;
}

/**
 * Build a structured issue message.
 * Single newline between sections — no blank lines.
 * Indentation is NOT added here; the caller handles presentation context.
 */
export function buildIssueMessage(msg: IssueMessage): string {
  return `${msg.what}\n${msg.why}\n${msg.next}`;
}
