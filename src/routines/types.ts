export type RoutineKind = 'learning.word_of_day' | 'agent.custom_prompt';

export interface DailyRoutineSchedule {
  type: 'daily';
  time: string;
  timezone: string;
}

export interface WeeklyRoutineSchedule {
  type: 'weekly';
  dayOfWeek: number;
  time: string;
  timezone: string;
}

export interface IntervalRoutineSchedule {
  type: 'interval';
  everyMinutes: number;
  timezone: string;
}

export type RoutineSchedule = DailyRoutineSchedule | WeeklyRoutineSchedule | IntervalRoutineSchedule;

export interface RoutineRecord {
  id: number;
  user_id: number;
  kind: RoutineKind;
  name: string;
  enabled: number;
  schedule: RoutineSchedule;
  config: Record<string, unknown>;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RoutineRunStatus = 'running' | 'success' | 'failed' | 'postponed';

export interface SkillRunResult {
  messages: string[];
  outputSummary: string;
  configUpdate?: Record<string, unknown>;
}
