import * as workingWithArchitecture from './working-with-architecture.js';
import * as aspectsOverview from './aspects-overview.js';
import * as writingLlmAspects from './writing-llm-aspects.js';
import * as writingDeterministicAspects from './writing-deterministic-aspects.js';
import * as conditionalAspects from './conditional-aspects.js';
import * as suppressSyntax from './suppress-syntax.js';
import * as verificationAndLock from './verification-and-lock.js';
import * as configuration from './configuration.js';
import * as cliReference from './cli-reference.js';
import * as logManagement from './log-management.js';
import * as portsAndRelations from './ports-and-relations.js';
import * as flows from './flows.js';
import * as aspectStatus from './aspect-status.js';
import * as metaModeling from './meta-modeling.js';
import * as onboarding from './onboarding.js';

export type KnowledgeTopic = {
  summary: string;
  content: string;
};

export const KNOWLEDGE_TOPICS: Record<string, KnowledgeTopic> = {
  'working-with-architecture': {
    summary: workingWithArchitecture.summary,
    content: workingWithArchitecture.content,
  },
  'aspects-overview': {
    summary: aspectsOverview.summary,
    content: aspectsOverview.content,
  },
  'meta-modeling': {
    summary: metaModeling.summary,
    content: metaModeling.content,
  },
  onboarding: {
    summary: onboarding.summary,
    content: onboarding.content,
  },
  'aspect-status': {
    summary: aspectStatus.summary,
    content: aspectStatus.content,
  },
  'writing-llm-aspects': {
    summary: writingLlmAspects.summary,
    content: writingLlmAspects.content,
  },
  'writing-deterministic-aspects': {
    summary: writingDeterministicAspects.summary,
    content: writingDeterministicAspects.content,
  },
  'conditional-aspects': {
    summary: conditionalAspects.summary,
    content: conditionalAspects.content,
  },
  'suppress-syntax': {
    summary: suppressSyntax.summary,
    content: suppressSyntax.content,
  },
  'verification-and-lock': {
    summary: verificationAndLock.summary,
    content: verificationAndLock.content,
  },
  configuration: {
    summary: configuration.summary,
    content: configuration.content,
  },
  'cli-reference': {
    summary: cliReference.summary,
    content: cliReference.content,
  },
  'log-management': {
    summary: logManagement.summary,
    content: logManagement.content,
  },
  'ports-and-relations': {
    summary: portsAndRelations.summary,
    content: portsAndRelations.content,
  },
  flows: {
    summary: flows.summary,
    content: flows.content,
  },
};
