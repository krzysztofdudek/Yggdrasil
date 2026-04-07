export interface LlmProvider {
  /** Verify source code against an aspect's content.md requirements */
  verifyAspect(params: {
    aspectContent: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<AspectResponse>;

  /** Review an artifact against source code */
  reviewArtifact(params: {
    artifactContent: string;
    artifactName: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<ArtifactResponse>;

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
