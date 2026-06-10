/**
 * Type definitions for scheduler event configuration objects as provided by the backend service.
 * Auto-generated file; regenerate whenever the contract changes.
 */
// Parsing helpers surface an error whenever the payload deviates from the expected interface, even if it is syntactically valid JSON.

export interface EventConfig {
  enabled: boolean;
  priority: number;
  interval: number;
  daily_reset: Array<number[]>;
  next_tick: number;
  event_name: string;
  func_name: string;
  disabled_time_range: any[];
  pre_task: any[];
  post_task: any[];
}
