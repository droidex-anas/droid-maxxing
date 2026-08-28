import {
  providerErrorCodeSchema,
  providerRecoveryActionSchema,
} from '../providers/providerErrors.js';
import {
  providerDriverKindSchema,
  providerInstanceIdSchema,
} from '../providers/providerIdentity.js';

export const DROIDEX_SCHEMA_VERSION = 1;
const DROIDEX_ID_MAX_BYTES = 256;

const ID = `BETWEEN 1 AND ${String(DROIDEX_ID_MAX_BYTES)}`;

function sqlStringLiteral(value: string): string {
  if (value.length === 0) {
    throw new Error('SQL string literals must be nonempty.');
  }
  if (value.includes("'")) {
    throw new Error(
      `Provider contract value contains a single quote and cannot be embedded in SQL.`,
    );
  }
  return `'${value}'`;
}

export function sqlInList(column: string, values: readonly string[]): string {
  if (values.length === 0) {
    throw new Error(`${column} CHECK requires at least one closed value.`);
  }
  const list = values.map(sqlStringLiteral).join(',\n    ');
  return `${column} IN (\n    ${list}\n  )`;
}

export function providerPairCheckSql(
  driverKinds: readonly string[],
  instanceIds: readonly string[],
): string {
  for (const value of driverKinds) sqlStringLiteral(value);
  for (const value of instanceIds) sqlStringLiteral(value);
  assertUniqueSqlValues(driverKinds, 'provider driver kind');
  assertUniqueSqlValues(instanceIds, 'provider instance id');
  const drivers = new Set(driverKinds);
  const instances = new Set(instanceIds);
  if (
    drivers.size !== instances.size ||
    instanceIds.some((id) => !drivers.has(id)) ||
    driverKinds.some((kind) => !instances.has(kind))
  ) {
    throw new Error(
      'Provider driver kind and instance id unions must contain the same members so SQL pairs stay exact.',
    );
  }
  const clauses = instanceIds.map(
    (id) =>
      `(provider_driver_kind = ${sqlStringLiteral(id)} AND provider_instance_id = ${sqlStringLiteral(id)})`,
  );
  return `(\n    ${clauses.join('\n    OR ')}\n  )`;
}

function assertUniqueSqlValues(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label} in provider contract.`);
  }
}

export const PROVIDER_PAIR_CHECK = providerPairCheckSql(
  providerDriverKindSchema.options,
  providerInstanceIdSchema.options,
);
export const FAILURE_CODE_CHECK = sqlInList('failure_code', providerErrorCodeSchema.options);
export const FAILURE_ACTION_CHECK = sqlInList(
  'failure_recovery_action',
  providerRecoveryActionSchema.options,
);

const SESSION_LIFECYCLE_CHECK = `lifecycle_status IN ('initializing', 'running', 'paused', 'completed', 'failed')`;

const TURN_LIFECYCLE_CHECK = `lifecycle_status IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled')`;

const TARGET_SHAPE_CHECK = `(
    (target_kind = 'session' AND child_session_id IS NULL)
    OR (target_kind = 'child' AND child_session_id IS NOT NULL AND length(child_session_id) ${ID})
  )`;

const FAILURE_FIELDS_CHECK = `(
    (
      lifecycle_status = 'failed'
      AND ${FAILURE_CODE_CHECK}
      AND length(failure_message) > 0
      AND ${FAILURE_ACTION_CHECK}
    )
    OR (
      lifecycle_status <> 'failed'
      AND failure_code IS NULL
      AND failure_message IS NULL
      AND failure_recovery_action IS NULL
    )
  )`;

const JSON_ARRAY_CHECK = `(json_valid(previous_provider_session_ids_json) AND json_type(previous_provider_session_ids_json) = 'array')`;

const CREATE_SESSIONS_SQL = `CREATE TABLE sessions (
  app_session_id TEXT PRIMARY KEY,
  client_ref TEXT NOT NULL,
  provider_driver_kind TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_session_id TEXT,
  previous_provider_session_ids_json TEXT NOT NULL,
  resume_state_json TEXT,
  runtime_generation INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  failure_code TEXT,
  failure_message TEXT,
  failure_recovery_action TEXT,
  hidden INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(app_session_id) ${ID}),
  CHECK (length(client_ref) ${ID}),
  CHECK ${PROVIDER_PAIR_CHECK},
  CHECK (provider_session_id IS NULL OR length(provider_session_id) ${ID}),
  CHECK ${JSON_ARRAY_CHECK},
  CHECK (resume_state_json IS NULL OR json_valid(resume_state_json)),
  CHECK (runtime_generation >= 0),
  CHECK (json_valid(summary_json)),
  CHECK (${SESSION_LIFECYCLE_CHECK}),
  CHECK ${FAILURE_FIELDS_CHECK},
  CHECK (hidden IN (0, 1)),
  CHECK (created_at >= 0),
  CHECK (updated_at >= 0)
)`;

const CREATE_CHILD_SESSIONS_SQL = `CREATE TABLE child_sessions (
  parent_app_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  provider_driver_kind TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_session_id TEXT,
  previous_provider_session_ids_json TEXT NOT NULL,
  resume_state_json TEXT,
  runtime_generation INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(parent_app_session_id, child_session_id),
  FOREIGN KEY (parent_app_session_id) REFERENCES sessions (app_session_id) ON DELETE CASCADE,
  CHECK (length(parent_app_session_id) ${ID}),
  CHECK (length(child_session_id) ${ID}),
  CHECK ${PROVIDER_PAIR_CHECK},
  CHECK (provider_session_id IS NULL OR length(provider_session_id) ${ID}),
  CHECK ${JSON_ARRAY_CHECK},
  CHECK (resume_state_json IS NULL OR json_valid(resume_state_json)),
  CHECK (runtime_generation >= 0),
  CHECK (json_valid(summary_json)),
  CHECK (${SESSION_LIFECYCLE_CHECK}),
  CHECK (created_at >= 0),
  CHECK (updated_at >= 0)
)`;

const CREATE_TURNS_SQL = `CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY,
  parent_app_session_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  child_session_id TEXT,
  runtime_generation INTEGER NOT NULL,
  lifecycle_status TEXT NOT NULL,
  provider_turn_id TEXT,
  started_at INTEGER NOT NULL,
  settled_at INTEGER,
  FOREIGN KEY (parent_app_session_id) REFERENCES sessions (app_session_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_app_session_id, child_session_id) REFERENCES child_sessions (parent_app_session_id, child_session_id) ON DELETE CASCADE,
  CHECK (length(turn_id) ${ID}),
  CHECK (length(parent_app_session_id) ${ID}),
  CHECK ${TARGET_SHAPE_CHECK},
  CHECK (runtime_generation >= 0),
  CHECK (${TURN_LIFECYCLE_CHECK}),
  CHECK (provider_turn_id IS NULL OR length(provider_turn_id) ${ID}),
  CHECK (started_at >= 0),
  CHECK (
    (
      lifecycle_status IN ('pending', 'running')
      AND settled_at IS NULL
    )
    OR (
      lifecycle_status IN ('completed', 'failed', 'interrupted', 'cancelled')
      AND settled_at IS NOT NULL
      AND settled_at >= 0
    )
  )
)`;

const CREATE_TRANSCRIPT_EVENTS_SQL = `CREATE TABLE transcript_events (
  event_order INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  parent_app_session_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  child_session_id TEXT,
  turn_id TEXT,
  runtime_generation INTEGER NOT NULL,
  provider_driver_kind TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_session_id TEXT,
  provider_turn_id TEXT,
  provider_item_id TEXT,
  payload_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (parent_app_session_id) REFERENCES sessions (app_session_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_app_session_id, child_session_id) REFERENCES child_sessions (parent_app_session_id, child_session_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns (turn_id) ON DELETE CASCADE,
  CHECK (length(event_id) ${ID}),
  CHECK (length(parent_app_session_id) ${ID}),
  CHECK ${TARGET_SHAPE_CHECK},
  CHECK (turn_id IS NULL OR length(turn_id) ${ID}),
  CHECK (runtime_generation >= 0),
  CHECK ${PROVIDER_PAIR_CHECK},
  CHECK (provider_session_id IS NULL OR length(provider_session_id) ${ID}),
  CHECK (provider_turn_id IS NULL OR length(provider_turn_id) ${ID}),
  CHECK (provider_item_id IS NULL OR length(provider_item_id) ${ID}),
  CHECK (json_valid(payload_json)),
  CHECK (created_at >= 0)
)`;

const CREATE_INDEX_SQL = [
  'CREATE UNIQUE INDEX sessions_client_ref_unique ON sessions (client_ref)',
  'CREATE UNIQUE INDEX sessions_native_binding_unique ON sessions (provider_instance_id, provider_session_id) WHERE provider_session_id IS NOT NULL',
  'CREATE INDEX sessions_activity ON sessions (hidden, updated_at DESC, app_session_id)',
  'CREATE UNIQUE INDEX child_sessions_native_binding_unique ON child_sessions (provider_instance_id, provider_session_id) WHERE provider_session_id IS NOT NULL',
  'CREATE INDEX child_sessions_activity ON child_sessions (parent_app_session_id, updated_at DESC, child_session_id)',
  'CREATE INDEX turns_target_activity ON turns (parent_app_session_id, child_session_id, started_at DESC, turn_id)',
  'CREATE INDEX transcript_events_session_page ON transcript_events (parent_app_session_id, event_order) WHERE child_session_id IS NULL',
  'CREATE INDEX transcript_events_child_page ON transcript_events (parent_app_session_id, child_session_id, event_order) WHERE child_session_id IS NOT NULL',
] as const;

const CREATE_SESSIONS_TRIGGER_SQL = `CREATE TRIGGER sessions_immutable_identity
BEFORE UPDATE ON sessions
WHEN NEW.app_session_id IS NOT OLD.app_session_id
  OR NEW.provider_driver_kind IS NOT OLD.provider_driver_kind
  OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
BEGIN
  SELECT RAISE(ABORT, 'sessions identity is immutable');
END`;

const CREATE_CHILD_SESSIONS_TRIGGER_SQL = `CREATE TRIGGER child_sessions_immutable_identity
BEFORE UPDATE ON child_sessions
WHEN NEW.parent_app_session_id IS NOT OLD.parent_app_session_id
  OR NEW.child_session_id IS NOT OLD.child_session_id
  OR NEW.provider_driver_kind IS NOT OLD.provider_driver_kind
  OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
BEGIN
  SELECT RAISE(ABORT, 'child_sessions identity is immutable');
END`;

export const DROIDEX_SCHEMA_SQL = [
  CREATE_SESSIONS_SQL,
  CREATE_CHILD_SESSIONS_SQL,
  CREATE_TURNS_SQL,
  CREATE_TRANSCRIPT_EVENTS_SQL,
  ...CREATE_INDEX_SQL,
  CREATE_SESSIONS_TRIGGER_SQL,
  CREATE_CHILD_SESSIONS_TRIGGER_SQL,
].join(';\n');

export interface ExpectedColumn {
  name: string;
  type: 'TEXT' | 'INTEGER';
  notnull: 0 | 1;
  pk: number;
}

export interface ExpectedForeignKey {
  table: string;
  from: readonly string[];
  to: readonly string[];
  onDelete: string;
}

export interface ExpectedIndex {
  name: string;
  table: string;
  unique: 0 | 1;
  partial: 0 | 1;
  columns: readonly string[];
  sql: string;
}

export interface ExpectedTable {
  name: string;
  columns: readonly ExpectedColumn[];
  foreignKeys: readonly ExpectedForeignKey[];
  sql: string;
}

export const EXPECTED_TABLES: readonly ExpectedTable[] = [
  {
    name: 'sessions',
    sql: CREATE_SESSIONS_SQL,
    columns: [
      { name: 'app_session_id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'client_ref', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'provider_driver_kind', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'provider_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'provider_session_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'previous_provider_session_ids_json', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'resume_state_json', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'runtime_generation', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'summary_json', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'lifecycle_status', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'failure_code', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'failure_message', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'failure_recovery_action', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'hidden', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ],
    foreignKeys: [],
  },
  {
    name: 'child_sessions',
    sql: CREATE_CHILD_SESSIONS_SQL,
    columns: [
      { name: 'parent_app_session_id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'child_session_id', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'provider_driver_kind', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'provider_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'provider_session_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'previous_provider_session_ids_json', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'resume_state_json', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'runtime_generation', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'summary_json', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'lifecycle_status', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ],
    foreignKeys: [
      {
        table: 'sessions',
        from: ['parent_app_session_id'],
        to: ['app_session_id'],
        onDelete: 'CASCADE',
      },
    ],
  },
  {
    name: 'turns',
    sql: CREATE_TURNS_SQL,
    columns: [
      { name: 'turn_id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'parent_app_session_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'target_kind', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'child_session_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'runtime_generation', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'lifecycle_status', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'provider_turn_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'started_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'settled_at', type: 'INTEGER', notnull: 0, pk: 0 },
    ],
    foreignKeys: [
      {
        table: 'child_sessions',
        from: ['parent_app_session_id', 'child_session_id'],
        to: ['parent_app_session_id', 'child_session_id'],
        onDelete: 'CASCADE',
      },
      {
        table: 'sessions',
        from: ['parent_app_session_id'],
        to: ['app_session_id'],
        onDelete: 'CASCADE',
      },
    ],
  },
  {
    name: 'transcript_events',
    sql: CREATE_TRANSCRIPT_EVENTS_SQL,
    columns: [
      { name: 'event_order', type: 'INTEGER', notnull: 0, pk: 1 },
      { name: 'event_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'parent_app_session_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'target_kind', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'child_session_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'turn_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'runtime_generation', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'provider_driver_kind', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'provider_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'provider_session_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'provider_turn_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'provider_item_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'payload_json', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'search_text', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ],
    foreignKeys: [
      {
        table: 'child_sessions',
        from: ['parent_app_session_id', 'child_session_id'],
        to: ['parent_app_session_id', 'child_session_id'],
        onDelete: 'CASCADE',
      },
      {
        table: 'sessions',
        from: ['parent_app_session_id'],
        to: ['app_session_id'],
        onDelete: 'CASCADE',
      },
      { table: 'turns', from: ['turn_id'], to: ['turn_id'], onDelete: 'CASCADE' },
    ],
  },
];

export const EXPECTED_INDEXES: readonly ExpectedIndex[] = [
  {
    name: 'sessions_client_ref_unique',
    table: 'sessions',
    unique: 1,
    partial: 0,
    columns: ['client_ref'],
    sql: CREATE_INDEX_SQL[0],
  },
  {
    name: 'sessions_native_binding_unique',
    table: 'sessions',
    unique: 1,
    partial: 1,
    columns: ['provider_instance_id', 'provider_session_id'],
    sql: CREATE_INDEX_SQL[1],
  },
  {
    name: 'sessions_activity',
    table: 'sessions',
    unique: 0,
    partial: 0,
    columns: ['hidden', 'updated_at', 'app_session_id'],
    sql: CREATE_INDEX_SQL[2],
  },
  {
    name: 'child_sessions_native_binding_unique',
    table: 'child_sessions',
    unique: 1,
    partial: 1,
    columns: ['provider_instance_id', 'provider_session_id'],
    sql: CREATE_INDEX_SQL[3],
  },
  {
    name: 'child_sessions_activity',
    table: 'child_sessions',
    unique: 0,
    partial: 0,
    columns: ['parent_app_session_id', 'updated_at', 'child_session_id'],
    sql: CREATE_INDEX_SQL[4],
  },
  {
    name: 'turns_target_activity',
    table: 'turns',
    unique: 0,
    partial: 0,
    columns: ['parent_app_session_id', 'child_session_id', 'started_at', 'turn_id'],
    sql: CREATE_INDEX_SQL[5],
  },
  {
    name: 'transcript_events_session_page',
    table: 'transcript_events',
    unique: 0,
    partial: 1,
    columns: ['parent_app_session_id', 'event_order'],
    sql: CREATE_INDEX_SQL[6],
  },
  {
    name: 'transcript_events_child_page',
    table: 'transcript_events',
    unique: 0,
    partial: 1,
    columns: ['parent_app_session_id', 'child_session_id', 'event_order'],
    sql: CREATE_INDEX_SQL[7],
  },
];

export const EXPECTED_TRIGGERS = [
  { name: 'sessions_immutable_identity', sql: CREATE_SESSIONS_TRIGGER_SQL },
  { name: 'child_sessions_immutable_identity', sql: CREATE_CHILD_SESSIONS_TRIGGER_SQL },
] as const;

export function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim().replace(/;$/, '');
}
