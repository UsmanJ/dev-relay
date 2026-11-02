export interface ProviderStatus {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean | null;
  authMethod: string | null;
  automationAllowed: boolean;
  notes: string[];
  error?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  kind: string;
  billing: string;
  roles: string[];
  writeCapable: boolean;
}

export interface StatusResponse {
  environment: { providers: ProviderStatus[]; billingEnvVars: string[]; checkedAt: string };
  providers: ProviderInfo[];
  activeJobs: Array<{ taskId: string; step: string; startedAt: number }>;
  recentErrors: Array<{ id: string; taskId: string | null; provider: string; role: string; errorKind: string | null; error: string | null; startedAt: string; status: string }>;
}

export interface ProjectSettings {
  pmProvider: string;
  devProvider: string;
  reviewProvider: string;
  maxRevisions: number;
  claudeModel: string | null;
  codexModel: string | null;
  allowTestExecution: boolean;
  testCommand: string[] | null;
  allowDirtyRepo: boolean;
  providerTimeoutMinutes: number;
  testTimeoutMinutes: number;
  baseRef: string;
  autoAdvance: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  githubUrl: string | null;
  productGoals: string;
  userRequirements: string;
  architecture: string;
  constraints: string;
  instructions: string;
  memorySummary: string;
  settings: ProjectSettings;
  pathVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  taskCounts?: Record<string, number>;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  type: string;
  request: string;
  status: string;
  pausedFrom: string | null;
  spec: Spec | null;
  revisionRound: number;
  maxRevisions: number;
  autoAdvance: boolean;
  branch: string | null;
  baseCommit: string | null;
  worktreePath: string | null;
  lastError: string | null;
  lastErrorKind: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Spec {
  title: string;
  type: string;
  summary: string;
  userStory: string;
  requirements: string[];
  acceptanceCriteria: Array<{ id: string; description: string; verification: string }>;
  nonGoals: string[];
  tradeOffs: string[];
  openQuestions: Array<{ id: string; question: string; context: string; blocking: boolean; addressedTo: string }>;
  suggestedTestPlan: string[];
  riskLevel: string;
}

export interface Message {
  id: string;
  role: string;
  provider: string;
  kind: string;
  round: number;
  body: string;
  payload: unknown;
  refs: { branch: string | null; commit: string | null; worktree: string | null; runId: string | null } | null;
  createdAt: string;
}