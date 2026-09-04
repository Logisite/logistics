import { EventEmitter } from 'node:events';

export interface ShipmentStatusEvent {
  shipmentId: string;
  runId: string | null;
  from: string;
  to: string;
  actorUserId: string;
  locationLabel?: string;
  occurredAt: Date;
}

export interface GpsPositionEvent {
  runId: string;
  driverUserId: string;
  latitude: number;
  longitude: number;
  recordedAt: Date;
}

export interface SyncEvents {
  'shipment:status': ShipmentStatusEvent;
  'gps:position': GpsPositionEvent;
}

type Handler<E> = (event: E) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- node's emitter types listeners as (...args: any[]) => void; this alias is the single boundary cast.
type Listener = (...args: any[]) => void;

/**
 * Minimal typed wrapper around node's EventEmitter. node's emitter is not
 * generic, so this keeps emit/on checked without fighting the stdlib types.
 */
class TypedEmitter<EMap> {
  private readonly ee = new EventEmitter();

  on<K extends keyof EMap>(type: K, fn: Handler<EMap[K]>): this {
    this.ee.on(type as string, fn as Listener);
    return this;
  }

  off<K extends keyof EMap>(type: K, fn: Handler<EMap[K]>): this {
    this.ee.off(type as string, fn as Listener);
    return this;
  }

  emit<K extends keyof EMap>(type: K, event: EMap[K]): boolean {
    return this.ee.emit(type as string, event);
  }
}

export const syncEmitter = new TypedEmitter<SyncEvents>();
