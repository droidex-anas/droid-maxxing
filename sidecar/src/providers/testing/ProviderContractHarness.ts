import assert from 'node:assert/strict';

import {
  admitProviderRuntimeEvent,
  parseProviderRuntimeEvent,
  type ProviderRuntimeEvent,
} from '../providerEvents.js';
import {
  assertDefinitionConsistency,
  parseProviderCapabilities,
  PROVIDER_CAPABILITY_KEYS,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderSession,
  type ProviderTurnSettlement,
} from '../providerTypes.js';
import type { ShutdownDeadline } from '../shutdownDeadline.js';

export function bindProviderAdapter<T extends ProviderAdapter>(adapter: T): T {
  assertDefinitionConsistency(adapter.definition);
  return adapter;
}

export function assertCompleteCapabilities(capabilities: ProviderCapabilities): void {
  const parsed = parseProviderCapabilities(capabilities);
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    assert.notEqual(parsed[key], undefined, `capability ${key} must be present`);
  }
}

export function assertStartTurnDidNotSettle(
  result: unknown,
  events: readonly ProviderRuntimeEvent[],
  turnId: string,
): void {
  assert.equal(
    result,
    undefined,
    'startTurn resolves on acceptance only and must not return a value',
  );
  const settlements = events.filter(
    (event) => event.type === 'turn.settled' && event.turnId === turnId,
  );
  assert.equal(
    settlements.length,
    0,
    'startTurn must not emit turn.settled; settlement is a later event',
  );
}

export function assertExactlyOneTurnSettlement(
  events: readonly ProviderRuntimeEvent[],
  turnId: string,
  settlement?: ProviderTurnSettlement,
): void {
  const settlements = events.filter(
    (event) => event.type === 'turn.settled' && event.turnId === turnId,
  );
  assert.equal(settlements.length, 1, `exactly one turn.settled is required for ${turnId}`);
  const event = settlements[0];
  if (event === undefined || event.type !== 'turn.settled') {
    assert.fail(`missing turn.settled for ${turnId}`);
    return;
  }
  parseProviderRuntimeEvent(event);
  if (settlement !== undefined) {
    assert.deepEqual(event.settlement, settlement);
  }
}

export function assertSameShutdownDeadline(
  received: ShutdownDeadline | undefined,
  expected: ShutdownDeadline,
): void {
  assert.equal(
    received,
    expected,
    'adapters must pass the absolute ShutdownDeadline through unchanged',
  );
}

export function assertActivateIsOneShot(session: ProviderSession): void {
  session.activate();
  assert.throws(() => session.activate());
}

export function assertPreActivationOverflow(outcome: {
  emittedToSink: number;
  discarded: boolean;
  closed: boolean;
  laterEventsAccepted: boolean;
  nativeCallbacksSettled: boolean;
}): void {
  assert.equal(
    outcome.emittedToSink,
    0,
    'overflow discards buffered output instead of flushing it',
  );
  assert.equal(outcome.discarded, true, 'overflow discards the pre-activation buffer');
  assert.equal(outcome.closed, true, 'overflow closes the provisional session');
  assert.equal(outcome.laterEventsAccepted, false, 'overflow accepts no later events');
  assert.equal(
    outcome.nativeCallbacksSettled,
    true,
    'overflow settles native callbacks before close',
  );
}

export function assertEventAdmissibleForSession(
  event: ProviderRuntimeEvent,
  session: {
    target: ProviderRuntimeEvent['target'];
    providerDriverKind: ProviderRuntimeEvent['providerDriverKind'];
    providerInstanceId: ProviderRuntimeEvent['providerInstanceId'];
    runtimeGeneration: number;
    settledTurnIds: ReadonlySet<string>;
  },
): void {
  parseProviderRuntimeEvent(event);
  const admission = admitProviderRuntimeEvent(event, session);
  assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
}
