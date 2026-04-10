// ─── Task Types ───

export type TaskStatus = 'planned' | 'scheduled' | 'active' | 'done' | 'failed' | 'pulled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type ModelChoice = 'opus' | 'sonnet' | 'haiku';

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  model: ModelChoice;
  maxBudgetUsd: number;
  retryCount: number;
  maxRetries: number;
  tags: string[];
  created: string;
  completed: string | null;
  tokenCost: { input: number; output: number; totalUsd: number };
  notes: string;
  parentGoal?: string;
  scheduledFor?: string; // ISO datetime — task moves to planned when time arrives
}

export interface TasksState {
  tasks: Task[];
  lastModified: string;
}

// ─── Agent Types ───

export type AgentRole = 'ceo' | 'worker';
export type AgentStatus = 'starting' | 'running' | 'idle' | 'stopping' | 'stopped' | 'crashed';
export type CeoDisplayStatus = 'Thinking' | 'Waiting' | 'Paused' | 'Stalled';

export interface SessionConfig {
  model: string;
  cwd: string;
  additionalDirectories: string[];
  mcpServers?: Record<string, unknown>;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  persistSession: boolean;
  canUseTool?: (tool: string, input: Record<string, unknown>, options?: unknown) => Promise<{ behavior: string }>;
}

export interface SessionInfo {
  sessionId: string;
  status: AgentStatus;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  startedAt: string;
  runtime: number; // ms
}

export interface AgentSession {
  id: string;
  role: AgentRole;
  taskId?: string;
  config: SessionConfig;
  status: AgentStatus;
  sessionId: string | null;
  process: unknown; // SDK session handle
  info: SessionInfo;
}

// ─── Safety Types ───

export interface SafetyConfig {
  maxConcurrentWorkers: number;
  maxDailyBudgetUsd: number;
  maxWorkerRuntimeMinutes: number;
  maxRetries: number;
  inactivityPauseMinutes: number;
  heartbeatIntervalMinutes: number;
  maxCeoSessionHours: number;
  maxPlannedTasks: number;
  requireApprovalForSpawn: boolean;
  workingHours?: {
    start: string;
    end: string;
    timezone: string;
  };
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  maxConcurrentWorkers: 3,
  maxDailyBudgetUsd: 50,
  maxWorkerRuntimeMinutes: 30,
  maxRetries: 2,
  inactivityPauseMinutes: 60,
  heartbeatIntervalMinutes: 10,
  maxCeoSessionHours: 8,
  maxPlannedTasks: 20,
  requireApprovalForSpawn: false,
};

// ─── Server Types ───

export interface EunomiaConfig {
  port: number;
  projectPath: string;
  safety: SafetyConfig;
  ceoModel: string;
}

export const DEFAULT_CONFIG: EunomiaConfig = {
  port: 4600,
  projectPath: '',
  safety: DEFAULT_SAFETY_CONFIG,
  ceoModel: 'claude-sonnet-4-6',
};

export interface HealthResponse {
  version: string;
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  ceo: {
    status: AgentStatus | 'not_started';
    model: string;
    sessionAge: string;
    tokensToday: number;
    costToday: number;
  };
  workers: {
    active: number;
    max: number;
  };
  budget: {
    spent: number;
    limit: number;
    percent: number;
  };
  tasks: Record<TaskStatus, number>;
  memory: {
    rss: string;
    heapUsed: string;
  };
}

// ─── WebSocket Message Types ───

export type WsMessageType =
  | 'terminal_output'
  | 'agent_status'
  | 'tasks_updated'
  | 'safety_alert'
  | 'spawn_approval_request'
  | 'cost_update';

export interface WsMessage {
  type: WsMessageType;
  agentId?: string;
  data: unknown;
  timestamp: string;
}

// ─── Audit Types ───

export interface AuditEntry {
  timestamp: string;
  actor: 'ceo' | 'human' | 'system';
  action: string;
  taskId?: string;
  detail: string;
}
