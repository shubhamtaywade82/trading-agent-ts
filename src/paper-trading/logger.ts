export interface LogEvent {
  timestamp: string;
  level: "info" | "warn" | "error";
  category: string;
  message: string;
  meta?: Record<string, unknown>;
}

export class StructuredLogger {
  private logs: LogEvent[] = [];

  constructor(private readonly category = "Agent") {}

  info(message: string, meta?: Record<string, unknown>): LogEvent {
    return this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): LogEvent {
    return this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): LogEvent {
    return this.log("error", message, meta);
  }

  private log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): LogEvent {
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      category: this.category,
      message,
      ...(meta !== undefined && { meta }),
    };
    this.logs.push(event);
    return event;
  }

  getLogs(): LogEvent[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }
}
