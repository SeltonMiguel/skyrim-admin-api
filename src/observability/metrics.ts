import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import type { ApplicationConfig } from '../config/environment.js';
import type { TickObserver } from '../lifecycle/tick-drain.js';

export const METRIC_PREFIX = 'skyrim_admin_';
// Every label of every custom metric, by name. Values must be closed enums
// (method, route template, status, command type, reason…): never an id,
// IP, username or free text. Checked by src/observability/metrics.spec.ts.
export const ALLOWED_LABELS = new Set([
  'method',
  'route',
  'status',
  'state',
  'outcome',
  'reason',
  'command_type',
  'actor_type',
  'error_code',
  'attempt',
  'type',
  'kind',
  'work',
  'surface',
  'worker',
  'phase',
  'version',
  'git_sha',
  'topology',
  'domain',
  'action',
]);
const LATENCY = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LIFECYCLE = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

type Collect = () => void | Promise<void>;

// The application's metrics (12.3): one Registry per application instance
// (no prom-client global registry), created by ObservabilityModule and
// exposed by GET /api/v1/metrics. Counters reset on restart by design;
// state gauges are read from memory registries or from the database by
// BacklogCollector, never kept by fragile increments.
@Injectable()
export class Metrics {
  readonly registry = new Registry();
  private readonly collectors: Collect[] = [];
  constructor(config: ConfigService<{ application: ApplicationConfig }, true>) {
    const application = config.get('application', { infer: true });
    collectDefaultMetrics({ register: this.registry, prefix: METRIC_PREFIX });
    this.info.set(
      {
        version: application.observability.version,
        git_sha: application.observability.gitSha,
        topology: application.deployment.topology,
      },
      1,
    );
    this.startTime.set(Math.floor(Date.now() / 1000));
  }
  private counter<L extends string>(name: string, help: string, labels: L[]) {
    return new Counter<L>({
      name: METRIC_PREFIX + name,
      help,
      labelNames: labels,
      registers: [this.registry],
    });
  }
  private gauge<L extends string>(
    name: string,
    help: string,
    labels: L[],
    collect?: (gauge: Gauge<L>) => void,
  ) {
    return new Gauge<L>({
      name: METRIC_PREFIX + name,
      help,
      labelNames: labels,
      registers: [this.registry],
      ...(collect
        ? {
            collect(this: Gauge<L>) {
              collect(this);
            },
          }
        : {}),
    });
  }
  private histogram<L extends string>(
    name: string,
    help: string,
    labels: L[],
    buckets = LIFECYCLE,
  ) {
    return new Histogram<L>({
      name: METRIC_PREFIX + name,
      help,
      labelNames: labels,
      buckets,
      registers: [this.registry],
    });
  }
  // Registers a synchronous read of in-memory state at scrape time.
  onCollect(collect: Collect): void {
    this.collectors.push(collect);
  }
  async render(): Promise<string> {
    for (const collect of this.collectors) await collect();
    return this.registry.metrics();
  }

  // Instance.
  readonly info = this.gauge('app_info', 'Build and topology (value 1).', [
    'version',
    'git_sha',
    'topology',
  ]);
  readonly startTime = this.gauge(
    'start_time_seconds',
    'Unix time the application started.',
    [],
  );
  readonly ready = this.gauge(
    'ready',
    'Lifecycle readiness (bootstrapped, not shutting down, lock held); 1 or 0. The database part of /ready is not repeated here.',
    [],
  );
  readonly instanceLock = this.gauge(
    'instance_lock_held',
    'Single-instance advisory lock held (1), lost or released (0), not required (-1).',
    [],
  );
  readonly shutdown = this.counter(
    'shutdown_total',
    'Graceful shutdown phases.',
    ['phase'],
  );

  // HTTP.
  readonly httpRequests = this.counter(
    'http_requests_total',
    'HTTP requests by route template.',
    ['method', 'route', 'status'],
  );
  readonly httpDuration = this.histogram(
    'http_request_duration_seconds',
    'HTTP request duration by route template.',
    ['method', 'route', 'status'],
    LATENCY,
  );

  // Database.
  readonly dbPool = this.gauge(
    'db_pool_connections',
    'Application pool connections (total, idle, waiting clients).',
    ['state'],
  );
  readonly dbQueryErrors = this.counter(
    'db_query_errors_total',
    'Failed database queries (no SQL is recorded).',
    [],
  );
  readonly dbPoolErrors = this.counter(
    'db_pool_errors_total',
    'Errors emitted by idle pool connections.',
    [],
  );

  // Host Agent.
  readonly agentSessions = this.gauge(
    'agent_sessions_active',
    'Active Host Agent sessions in this process.',
    [],
  );
  readonly agentAuth = this.counter(
    'agent_auth_total',
    'Host Agent HELLO outcomes.',
    ['outcome', 'reason'],
  );
  readonly agentAdmissionRejects = this.counter(
    'agent_admission_rejects_total',
    'Host Agent connections refused before or during HELLO.',
    ['reason'],
  );
  readonly agentCloses = this.counter(
    'agent_session_closes_total',
    'Host Agent sockets closed by the backend, by close reason.',
    ['reason'],
  );
  readonly agentDisconnects = this.counter(
    'agent_disconnects_total',
    'Host Agent sessions ended, by persisted disconnect reason.',
    ['reason'],
  );

  // GameCommand.
  readonly commandsCreated = this.counter(
    'game_commands_created_total',
    'GameCommands created.',
    ['command_type', 'actor_type'],
  );
  readonly commandDispatches = this.counter(
    'game_command_dispatch_attempts_total',
    'Dispatch attempts (first or retry).',
    ['command_type', 'attempt'],
  );
  readonly commandTerminal = this.counter(
    'game_command_terminal_total',
    'GameCommands reaching a terminal status.',
    ['command_type', 'status', 'error_code'],
  );
  readonly commandResultRejects = this.counter(
    'game_command_result_rejections_total',
    'ACK/RESULT frames refused by the backend.',
    ['reason'],
  );
  readonly commandCreateToDispatch = this.histogram(
    'game_command_create_to_dispatch_seconds',
    'Creation to first dispatch.',
    ['command_type'],
  );
  readonly commandDispatchToAck = this.histogram(
    'game_command_dispatch_to_ack_seconds',
    'Last dispatch to ACK.',
    ['command_type'],
  );
  readonly commandAckToTerminal = this.histogram(
    'game_command_ack_to_terminal_seconds',
    'ACK to terminal status.',
    ['command_type', 'status'],
  );
  readonly commandDuration = this.histogram(
    'game_command_duration_seconds',
    'Creation to terminal status.',
    ['command_type', 'status'],
  );
  readonly commandBacklog = this.gauge(
    'game_commands_backlog',
    'Non-terminal GameCommands by status (database, periodic).',
    ['status'],
  );
  readonly commandOldest = this.gauge(
    'game_commands_oldest_age_seconds',
    'Age of the oldest non-terminal GameCommand by status (database, periodic).',
    ['status'],
  );

  // Server Control.
  readonly controlCreated = this.counter(
    'server_control_created_total',
    'Server Control operations created.',
    ['type'],
  );
  readonly controlTerminal = this.counter(
    'server_control_terminal_total',
    'Server Control operations reaching SUCCEEDED, FAILED or UNCERTAIN.',
    ['type', 'status', 'error_code'],
  );
  readonly controlUncertain = this.counter(
    'server_control_uncertain_total',
    'Server Control operations that became UNCERTAIN (operator attention).',
    ['type'],
  );
  readonly controlDuration = this.histogram(
    'server_control_duration_seconds',
    'Creation to terminal status, for results reported by the Agent.',
    ['type', 'status'],
  );
  readonly controlResultRejects = this.counter(
    'server_control_result_rejections_total',
    'SERVER_CONTROL_RESULT frames refused by the backend.',
    ['reason'],
  );
  readonly controlOperations = this.gauge(
    'server_control_operations',
    'Server Control operations by status (database, periodic; UNCERTAIN counts only those without an operator resolution, 12.4).',
    ['status'],
  );

  // Domain events and work.
  readonly domainEvents = this.counter(
    'domain_events_total',
    'DOMAIN_EVENT outcomes by kind.',
    ['kind', 'outcome'],
  );
  readonly workSyncs = this.counter(
    'work_sync_requests_total',
    'WORK_SYNC outcomes.',
    ['outcome'],
  );
  readonly workBacklog = this.gauge(
    'work_backlog',
    'Gameplay work waiting for the Agent (database, periodic).',
    ['work'],
  );
  readonly workOldest = this.gauge(
    'work_oldest_age_seconds',
    'Age of the oldest waiting item by work (database, periodic).',
    ['work'],
  );
  readonly vipDeliveries = this.gauge(
    'vip_deliveries',
    'VIP reward deliveries by status (database, periodic).',
    ['status'],
  );
  readonly vipOldest = this.gauge(
    'vip_delivery_oldest_open_age_seconds',
    'Age of the oldest PENDING or COMMAND_CREATED delivery (database, periodic).',
    [],
  );
  // Operational recovery (12.4).
  readonly operatorActions = this.counter(
    'operator_actions_total',
    'Operator recovery interventions by domain, action kind and outcome (applied, replayed, rejected).',
    ['domain', 'action', 'outcome'],
  );
  readonly recoveryUnresolved = this.gauge(
    'recovery_unresolved',
    'Items needing an operator decision, without a resolution (database, periodic).',
    ['domain'],
  );
  readonly recoveryResolved = this.gauge(
    'recovery_resolved',
    'Items an operator resolved (database, periodic; cumulative over retained rows).',
    ['domain'],
  );
  readonly recoveryOldest = this.gauge(
    'recovery_oldest_unresolved_age_seconds',
    'Age of the oldest unresolved item by domain (database, periodic).',
    ['domain'],
  );
  readonly backlogCollected = this.gauge(
    'backlog_collection_timestamp_seconds',
    'Unix time of the last successful database backlog collection.',
    [],
  );
  readonly backlogErrors = this.counter(
    'backlog_collection_errors_total',
    'Failed database backlog collections.',
    [],
  );

  // Realtime.
  readonly realtimeConnections = this.gauge(
    'realtime_connections',
    'Authenticated realtime sockets by surface.',
    ['surface'],
  );
  readonly realtimeRejects = this.counter(
    'realtime_rejects_total',
    'Realtime connections refused or closed by the backend.',
    ['reason'],
  );
  readonly realtimeSlowDrops = this.counter(
    'realtime_slow_client_drops_total',
    'Realtime sockets dropped for exceeding the outbound buffer.',
    [],
  );
  readonly realtimeEvents = this.counter(
    'realtime_events_published_total',
    'Realtime events published, by surface.',
    ['surface'],
  );
  readonly realtimeDeliveryFailures = this.counter(
    'realtime_delivery_failures_total',
    'Realtime frames that could not be written to an open socket.',
    [],
  );

  // Workers.
  readonly workerTicks = this.counter(
    'worker_ticks_total',
    'Worker ticks by outcome.',
    ['worker', 'outcome'],
  );
  readonly workerSkipped = this.counter(
    'worker_ticks_skipped_total',
    'Ticks skipped because the previous one was still running.',
    ['worker'],
  );
  readonly workerDuration = this.histogram(
    'worker_tick_duration_seconds',
    'Worker tick duration.',
    ['worker'],
    LATENCY,
  );
  readonly workerLastSuccess = this.gauge(
    'worker_last_success_timestamp_seconds',
    'Unix time of the last successful tick.',
    ['worker'],
  );
  readonly workerRunning = this.gauge(
    'worker_running',
    'A tick is running (1) or not (0).',
    ['worker'],
  );

  worker(worker: string): TickObserver {
    this.workerRunning.set({ worker }, 0);
    return {
      started: () => this.workerRunning.set({ worker }, 1),
      finished: (ok, seconds) => {
        this.workerRunning.set({ worker }, 0);
        this.workerTicks.inc({ worker, outcome: ok ? 'success' : 'error' });
        this.workerDuration.observe({ worker }, seconds);
        if (ok)
          this.workerLastSuccess.set({ worker }, Math.floor(Date.now() / 1000));
      },
      skipped: () => this.workerSkipped.inc({ worker }),
    };
  }
}
// Seconds between two instants (null-safe, never negative).
export const seconds = (from?: Date | null, to?: Date | null): number | null =>
  from && to ? Math.max(0, (to.getTime() - from.getTime()) / 1000) : null;
