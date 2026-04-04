export interface LlmProvider {
  /** Verify a claim against source code */
  verifyClaim(params: {
    aspectContent: string;
    claim: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<ClaimResponse>;

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

export interface ClaimResponse {
  satisfied: boolean;
  reason: string;
}

export interface ArtifactResponse {
  current: boolean;
  reason: string;
}
