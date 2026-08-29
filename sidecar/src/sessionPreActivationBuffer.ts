import { PRE_ACTIVATION_MAX_BYTES, PRE_ACTIVATION_MAX_EVENTS } from './providers/providerTypes.js';
import {
  serializedProviderEventBytes,
  type ProviderRuntimeEvent,
} from './providers/providerEvents.js';

export { PRE_ACTIVATION_MAX_BYTES, PRE_ACTIVATION_MAX_EVENTS };

export class SessionPreActivationBuffer {
  #events: ProviderRuntimeEvent[] = [];
  #bytes = 0;

  get size(): number {
    return this.#events.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  tryPush(event: ProviderRuntimeEvent): boolean {
    const nextBytes = serializedProviderEventBytes(event);
    if (
      this.#events.length >= PRE_ACTIVATION_MAX_EVENTS ||
      this.#bytes + nextBytes > PRE_ACTIVATION_MAX_BYTES
    ) {
      return false;
    }
    this.#events.push(event);
    this.#bytes += nextBytes;
    return true;
  }

  drain(): ProviderRuntimeEvent[] {
    const events = this.#events;
    this.#events = [];
    this.#bytes = 0;
    return events;
  }
}
