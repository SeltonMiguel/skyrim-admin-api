import { Injectable } from '@nestjs/common';
import type { LoggerService, LogLevel } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfig } from '../config/environment.js';
import { RequestContext } from '../common/request-context/request-context.service.js';
import { redactText, redactValue } from './redaction.js';

const ORDER: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];
// "Message text [key=value key=value]" → message + fields (the existing
// log style of the backend, kept by every component).
const FIELDS = /^(.*?)\s*\[((?:[\w.-]+=[^\s\]]*\s*)+)\]$/;

export interface LogRecord {
  time: string;
  level: string;
  context?: string;
  message: string;
  requestId?: string;
  [field: string]: unknown;
}

// Structured application logger (12.3): JSON lines in production
// (LOG_FORMAT=json), a readable single line otherwise. Every record carries
// time, level, context and the current requestId; bracketed key=value
// fields become JSON fields (commandId, operationId, eventId,
// correlationId…). Everything goes through the central redaction. No
// external service: stdout/stderr only.
@Injectable()
export class AppLogger implements LoggerService {
  private readonly format: 'json' | 'pretty';
  private readonly threshold: number;
  // Test hooks: receive every emitted record; `echo=false` keeps stdout quiet.
  sink?: (record: LogRecord) => void;
  echo = true;
  constructor(
    config: ConfigService<{ application: ApplicationConfig }, true>,
    private readonly context?: RequestContext,
  ) {
    const observability = config.get('application', {
      infer: true,
    }).observability;
    this.format = observability.logFormat;
    this.threshold = ORDER.indexOf(observability.logLevel);
  }
  log(message: unknown, ...params: unknown[]) {
    this.write('log', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  // Nest passes (message, stack?, context?) for errors.
  error(message: unknown, ...params: unknown[]) {
    const context =
      params.length > 1 && typeof params.at(-1) === 'string'
        ? (params.pop() as string)
        : undefined;
    const stack = params[0];
    this.write('error', message, context ? [context] : [], stack);
  }
  record(
    level: LogLevel,
    message: unknown,
    params: unknown[],
    stack?: unknown,
  ): LogRecord {
    const context =
      typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      message: '',
    };
    const requestId = this.context?.requestId;
    if (requestId) record.requestId = requestId;
    if (message && typeof message === 'object' && !(message instanceof Error)) {
      const { message: text, ...fields } = redactValue(message) as Record<
        string,
        unknown
      >;
      Object.assign(record, fields);
      record.message = typeof text === 'string' ? text : '';
    } else if (message instanceof Error) {
      record.message = redactText(message.message);
      record.error = {
        name: message.name,
        stack: redactText(message.stack ?? ''),
      };
    } else {
      const text = redactText(String(message));
      const match = FIELDS.exec(text);
      record.message = match ? match[1] : text;
      if (match)
        for (const pair of match[2].trim().split(/\s+/)) {
          const at = pair.indexOf('=');
          record[pair.slice(0, at)] = pair.slice(at + 1);
        }
    }
    if (typeof stack === 'string' && stack)
      record.error = { ...(record.error as object), stack: redactText(stack) };
    return record;
  }
  private write(
    level: LogLevel,
    message: unknown,
    params: unknown[],
    stack?: unknown,
  ) {
    if (ORDER.indexOf(level) > this.threshold) return;
    const record = this.record(level, message, params, stack);
    this.sink?.(record);
    if (!this.echo) return;
    const line =
      this.format === 'json' ? JSON.stringify(record) : pretty(record);
    (level === 'error' || level === 'warn'
      ? process.stderr
      : process.stdout
    ).write(`${line}\n`);
  }
}
function pretty(record: LogRecord): string {
  const { time, level, context, message, ...fields } = record;
  const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  return `${time} ${level.toUpperCase().padEnd(7)} ${context ? `[${context}] ` : ''}${message}${extra}`;
}
