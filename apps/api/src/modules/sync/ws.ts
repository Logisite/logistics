import { eq } from 'drizzle-orm';
import { WebSocket, WebSocketServer } from 'ws';

import { runs, shipments } from '@logistics/db';

import type { Db } from '../../shared/db.js';
import { getConfig } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { verifyAccessToken } from '../auth/tokens.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../auth/permissions.js';

import type { GpsPositionEvent, ShipmentStatusEvent } from './events.js';
import { syncEmitter } from './events.js';

const HEARTBEAT_MS = 30_000;
const MAX_MISSED_PONGS = 2;

const STAFF_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'DISPATCHER']);

interface ClientState {
  claims: AccessTokenClaims;
  rooms: Set<string>;
  alive: boolean;
  missedPongs: number;
}

const rooms = new Map<string, Set<WebSocket>>();
const clients = new Map<WebSocket, ClientState>();
const wired = new WeakSet<WebSocketServer>();

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function sendToRoom(room: string, message: unknown): void {
  const payload = JSON.stringify(message);
  for (const ws of rooms.get(room) ?? []) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function joinRoom(ws: WebSocket, state: ClientState, room: string): void {
  let members = rooms.get(room);
  if (!members) {
    members = new Set();
    rooms.set(room, members);
  }
  members.add(ws);
  state.rooms.add(room);
}

function leaveRoom(ws: WebSocket, state: ClientState, room: string): void {
  rooms.get(room)?.delete(ws);
  if (rooms.get(room)?.size === 0) rooms.delete(room);
  state.rooms.delete(room);
}

function leaveAllRooms(ws: WebSocket, state: ClientState): void {
  for (const room of [...state.rooms]) leaveRoom(ws, state, room);
}

function hasPermission(role: AccessTokenClaims['role'], permission: string): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(
    permission as (typeof ROLE_PERMISSIONS)[typeof role][number],
  );
}

async function canJoinRunRoom(db: Db, claims: AccessTokenClaims, runId: string): Promise<boolean> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return false;
  if (run.driverUserId === claims.sub) return true;
  return STAFF_ROLES.has(claims.role);
}

async function canJoinTrackRoom(
  db: Db,
  claims: AccessTokenClaims,
  shipmentId: string,
): Promise<boolean> {
  const [shipment] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  if (!shipment) return false;
  if (shipment.senderUserId === claims.sub) return true;
  if (
    shipment.recipientEmail &&
    shipment.recipientEmail.toLowerCase() === claims.email.toLowerCase()
  ) {
    return true;
  }
  return hasPermission(claims.role, PERMISSIONS.AUDIT_READ);
}

async function handleSubscribe(
  db: Db,
  ws: WebSocket,
  state: ClientState,
  room: unknown,
): Promise<void> {
  if (typeof room !== 'string' || room.length === 0) {
    send(ws, { type: 'error', code: 'BAD_ROOM', message: 'room must be a non-empty string' });
    return;
  }
  const runMatch = /^run:(.+)$/.exec(room);
  const trackMatch = /^track:(.+)$/.exec(room);
  if (!runMatch && !trackMatch) {
    send(ws, { type: 'error', code: 'UNKNOWN_ROOM', message: 'room must be run:{id} or track:{id}' });
    return;
  }

  let allowed = false;
  if (runMatch) allowed = await canJoinRunRoom(db, state.claims, runMatch[1]!);
  else if (trackMatch) allowed = await canJoinTrackRoom(db, state.claims, trackMatch[1]!);

  if (!allowed) {
    logger.warn({ userId: state.claims.sub, role: state.claims.role, room }, 'sync.ws-subscribe-denied');
    send(ws, { type: 'error', code: 'FORBIDDEN', message: 'not authorized for this room', room });
    return;
  }

  joinRoom(ws, state, room);
  logger.info({ userId: state.claims.sub, room }, 'sync.ws-subscribed');
  send(ws, { type: 'subscribed', room });
}

function onShipmentStatus(event: ShipmentStatusEvent): void {
  const message = { type: 'shipment:status', data: event };
  sendToRoom(`track:${event.shipmentId}`, message);
  if (event.runId) sendToRoom(`run:${event.runId}`, message);
}

function onGpsPosition(event: GpsPositionEvent): void {
  sendToRoom(`run:${event.runId}`, { type: 'gps:position', data: event });
}

/**
 * Attach the sync WebSocket protocol to a server. Idempotent per instance.
 *
 * Protocol: connect to /ws?token=<JWT>. Send { type: 'subscribe', room } and
 * { type: 'unsubscribe', room }. Rooms are run:{runId} (assigned driver or
 * staff) and track:{shipmentId} (sender, recipient, or audit:read).
 */
export function setupWs(wss: WebSocketServer, db: Db): void {
  if (wired.has(wss)) return;
  wired.add(wss);

  syncEmitter.on('shipment:status', onShipmentStatus);
  syncEmitter.on('gps:position', onGpsPosition);

  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!state.alive) {
        state.missedPongs += 1;
        if (state.missedPongs >= MAX_MISSED_PONGS) {
          logger.warn({ userId: state.claims.sub }, 'sync.ws-heartbeat-timeout');
          ws.terminate();
          continue;
        }
      } else {
        state.missedPongs = 0;
      }
      state.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    if (!token) {
      ws.close(4001, 'missing token');
      return;
    }

    verifyAccessToken(token, getConfig().jwtAccessSecret).then(
      (claims) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const state: ClientState = { claims, rooms: new Set(), alive: true, missedPongs: 0 };
        clients.set(ws, state);
        logger.info({ userId: claims.sub, role: claims.role }, 'sync.ws-connected');

        ws.on('pong', () => {
          state.alive = true;
        });

        ws.on('message', (raw) => {
          let msg: { type?: unknown; room?: unknown };
          try {
            msg = JSON.parse(String(raw)) as { type?: unknown; room?: unknown };
          } catch {
            send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'message must be JSON' });
            return;
          }
          if (msg.type === 'subscribe') {
            void handleSubscribe(db, ws, state, msg.room).catch((err: unknown) => {
              logger.error({ err, userId: claims.sub }, 'sync.ws-subscribe-failed');
              send(ws, { type: 'error', code: 'INTERNAL', message: 'subscribe failed' });
            });
          } else if (msg.type === 'unsubscribe' && typeof msg.room === 'string') {
            leaveRoom(ws, state, msg.room);
            send(ws, { type: 'unsubscribed', room: msg.room });
          } else {
            send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'unknown message type' });
          }
        });

        ws.on('close', () => {
          leaveAllRooms(ws, state);
          clients.delete(ws);
          logger.info({ userId: claims.sub }, 'sync.ws-disconnected');
        });

        ws.on('error', (err) => {
          logger.error({ err, userId: claims.sub }, 'sync.ws-error');
        });
      },
      () => {
        ws.close(4001, 'invalid token');
      },
    );
  });
}
