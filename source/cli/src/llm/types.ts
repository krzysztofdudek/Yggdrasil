export interface AspectVerifyParams {
  /** Inline aspect content (for API providers) */
  aspectContent: string;
  /** Aspect id, e.g. "posix-paths" */
  aspectId: string;
  /** Path to aspect content.md relative to project root */
  aspectContentPath: string;
  /** Inline formatted source code (for API providers) */
  sourceCode: string;
  /** Source file paths relative to project root */
  sourceFiles: string[];
  /** Node graph path, e.g. "cli/core/drift-detector" */
  nodePath: string;
  /** Node type from architecture, e.g. "command", "engine" */
  nodeType?: string;
  /** Absolute path to project root (parent of .yggdrasil/) */
  projectRoot: string;
  /** Pre-computed yg context --node output (for API providers) or node path for CLI to run */
  nodeContext?: string;
}

export interface ArtifactReviewParams {
  artifactContent: string;
  artifactName: string;
  sourceCode: string;
  sourceFiles: string[];
  /** Node graph path */
  nodePath?: string;
  /** Node type name from architecture (e.g. "command", "engine") */
  nodeType?: string;
  /** Quality profile from architecture — type-specific evaluation criteria */
  qualityProfile?: string;
  /** Pre-computed yg context --node output (for API providers) or node path for CLI to run */
  nodeContext?: string;
  /** Absolute path to project root — used as cwd for CLI providers reading files */
  projectRoot?: string;
}

export interface LlmProvider {
  /** Verify source code against an aspect's content.md requirements */
  verifyAspect(params: AspectVerifyParams): Promise<AspectResponse>;

  /** Review an artifact against source code */
  reviewArtifact(params: ArtifactReviewParams): Promise<ArtifactResponse>;

  /** Whether this provider needs source content chunked into the prompt (API providers).
   *  CLI-based providers (claude-code) read files themselves and don't need chunking. */
  readonly needsChunking: boolean;

  /** Check if provider is available */
  isAvailable(): Promise<boolean>;

  /** Query model context window size. Returns undefined if not supported. */
  getContextWindowSize(): Promise<number | undefined>;
}

export interface AspectResponse {
  satisfied: boolean;
  reason: string;
}

export interface ArtifactResponse {
  current: boolean;
  reason: string;
}
