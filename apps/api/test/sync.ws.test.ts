import { createServer } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/modules/auth/seed.js';
import { setupWs } from '../src/modules/sync/ws.js';
import type { Db } from '../src/shared/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

interface WsMessage {
  type: string;
  room?: string;
  code?: string;
  data?: Record<string, unknown>;
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as WsMessage);
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ws close')), timeoutMs);
    ws.once('close', (code: number) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

async function connect(wsUrl: string, token?: string): Promise<WebSocket> {
  const url = token === undefined ? wsUrl : `${wsUrl}?token=${token}`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

async function subscribe(ws: WebSocket, room: string): Promise<WsMessage> {
  const ack = nextMessage(ws);
  ws.send(JSON.stringify({ type: 'subscribe', room }));
  return ack;
}

describe('sync websocket', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let httpServer: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let wsUrl: string;

  let driverToken: string;
  let driverId: string;
  let outsiderToken: string;
  let dispatcherToken: string;
  let merchantToken: string;
  let runId: string;
  let shipmentId: string;

  async function seedHubZonePickup() {
    const stamp = Date.now();
    const hubRes = await request(app).post('/api/v1/locations/hubs').set('Authorization', `Bearer ${dispatcherToken}`).send({ name: `Hub ${stamp}`, code: `H${stamp}`, address: '1 Test St' });
    const hubId = hubRes.body.hub.id as string;
    const oz = await request(app).post('/api/v1/locations/zones').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId, name: `OZ ${stamp}` });
    const dz = await request(app).post('/api/v1/locations/zones').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId, name: `DZ ${stamp}` });
    const pr = await request(app).post('/api/v1/locations/pickup-points').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId, zoneId: oz.body.zone.id, name: 'Pickup', address: '2 Test St' });
    const opt = await request(app).post('/api/v1/pricing/delivery-options').set('Authorization', `Bearer ${dispatcherToken}`).send({ code: `STD${stamp}`, name: 'Standard' });
    await request(app).post('/api/v1/pricing/rules').set('Authorization', `Bearer ${dispatcherToken}`).send({ originZoneId: oz.body.zone.id, destinationZoneId: dz.body.zone.id, sizeClass: 'SMALL', weightClass: 'LIGHT', deliveryOptionId: opt.body.deliveryOption.id, currency: 'GBP', amountCents: 1500, validFrom: new Date().toISOString() });
    return { hubId, originZoneId: oz.body.zone.id, destZoneId: dz.body.zone.id, pickupLocationId: pr.body.pickupLocation.id, deliveryOptionId: opt.body.deliveryOption.id };
  }

  beforeAll(async () => {
    testDb = await createTestDb({ postgis: true });
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);

    await seedUserWithRoles(db, ['DRIVER'], 'driver-ws@example.com');
    await seedUserWithRoles(db, ['DRIVER'], 'outsider-ws@example.com');
    await seedUserWithRoles(db, ['DISPATCHER'], 'dispatcher-ws@example.com');
    await seedUserWithRoles(db, ['MERCHANT'], 'merchant-ws@example.com');

    const login = async (email: string) =>
      (await request(app).post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD })).body.accessToken as string;
    driverToken = await login('driver-ws@example.com');
    outsiderToken = await login('outsider-ws@example.com');
    dispatcherToken = await login('dispatcher-ws@example.com');
    merchantToken = await login('merchant-ws@example.com');
    driverId = (await db.query.users.findFirst({ where: (t, { eq }) => eq(t.email, 'driver-ws@example.com') }))!.id;

    const ids = await seedHubZonePickup();
    const bookRes = await request(app).post('/api/v1/pricing/book').set('Authorization', `Bearer ${merchantToken}`).send({ recipientName: 'WS Recipient', pickupLocationId: ids.pickupLocationId, destinationZoneId: ids.destZoneId, deliveryOptionId: ids.deliveryOptionId, packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }] });
    expect(bookRes.status).toBe(201);
    shipmentId = bookRes.body.shipment.id as string;

    const runRes = await request(app).post('/api/v1/runs').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId, sequence: 0 }] });
    expect(runRes.status).toBe(201);
    runId = runRes.body.run.id as string;
    const startRes = await request(app).post(`/api/v1/runs/${runId}/start`).set('Authorization', `Bearer ${dispatcherToken}`).send();
    expect(startRes.status).toBe(200);

    httpServer = createServer(app);
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    setupWs(wss, db);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await testDb.cleanup();
  });

  it('opens with a valid JWT and subscribes to a run room', async () => {
    const ws = await connect(wsUrl, driverToken);
    try {
      const ack = await subscribe(ws, `run:${runId}`);
      expect(ack).toMatchObject({ type: 'subscribed', room: `run:${runId}` });
    } finally {
      ws.close();
    }
  });

  it('closes with 4001 on an invalid token', async () => {
    const ws = new WebSocket(`${wsUrl}?token=invalid`);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4001);
  });

  it('closes with 4001 when the token is missing', async () => {
    const ws = new WebSocket(wsUrl);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4001);
  });

  it('assigned driver receives gps broadcasts on the run room', async () => {
    const ws = await connect(wsUrl, driverToken);
    try {
      await subscribe(ws, `run:${runId}`);
      const broadcast = nextMessage(ws);
      const pushRes = await request(app).post(`/api/v1/runs/${runId}/gps`).set('Authorization', `Bearer ${driverToken}`).send({ positions: [{ latitude: 51.5, longitude: -0.12 }] });
      expect(pushRes.status).toBe(200);
      const msg = await broadcast;
      expect(msg.type).toBe('gps:position');
      expect(msg.data).toMatchObject({ runId, latitude: 51.5, longitude: -0.12 });
    } finally {
      ws.close();
    }
  });

  it('rejects subscription to a run room for an unassigned driver', async () => {
    const ws = await connect(wsUrl, outsiderToken);
    try {
      const ack = await subscribe(ws, `run:${runId}`);
      expect(ack).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    } finally {
      ws.close();
    }
  });

  it('dispatcher (staff) can join the run room', async () => {
    const ws = await connect(wsUrl, dispatcherToken);
    try {
      const ack = await subscribe(ws, `run:${runId}`);
      expect(ack).toMatchObject({ type: 'subscribed', room: `run:${runId}` });
    } finally {
      ws.close();
    }
  });

  it('sender receives shipment broadcasts on the track room', async () => {
    const ws = await connect(wsUrl, merchantToken);
    try {
      await subscribe(ws, `track:${shipmentId}`);
      const broadcast = nextMessage(ws);
      const transRes = await request(app).post(`/api/v1/shipments/${shipmentId}/pickup`).set('Authorization', `Bearer ${dispatcherToken}`).send({});
      expect(transRes.status).toBe(200);
      const msg = await broadcast;
      expect(msg.type).toBe('shipment:status');
      expect(msg.data).toMatchObject({ shipmentId, from: 'BOOKED', to: 'PICKED_UP' });
    } finally {
      ws.close();
    }
  });

  it('stops receiving after unsubscribe', async () => {
    const ws = await connect(wsUrl, driverToken);
    try {
      await subscribe(ws, `run:${runId}`);
      const unsub = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'unsubscribe', room: `run:${runId}` }));
      expect(await unsub).toMatchObject({ type: 'unsubscribed', room: `run:${runId}` });

      const received: WsMessage[] = [];
      ws.on('message', (raw) => {
        received.push(JSON.parse(String(raw)) as WsMessage);
      });
      await request(app).post(`/api/v1/runs/${runId}/gps`).set('Authorization', `Bearer ${driverToken}`).send({ positions: [{ latitude: 51.6, longitude: -0.11 }] });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(received).toHaveLength(0);

      const reSub = await subscribe(ws, `run:${runId}`);
      expect(reSub).toMatchObject({ type: 'subscribed' });
    } finally {
      ws.close();
    }
  });

  it('disconnect cleans up so a new connection receives exactly one copy', async () => {
    const first = await connect(wsUrl, driverToken);
    await subscribe(first, `run:${runId}`);
    first.close();
    await waitForClose(first);

    const second = await connect(wsUrl, driverToken);
    try {
      await subscribe(second, `run:${runId}`);
      const broadcast = nextMessage(second);
      await request(app).post(`/api/v1/runs/${runId}/gps`).set('Authorization', `Bearer ${driverToken}`).send({ positions: [{ latitude: 51.7, longitude: -0.1 }] });
      const msg = await broadcast;
      expect(msg.type).toBe('gps:position');

      const extra: WsMessage[] = [];
      second.on('message', (raw) => {
        extra.push(JSON.parse(String(raw)) as WsMessage);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(extra).toHaveLength(0);
    } finally {
      second.close();
    }
  });

  it('fans out to multiple clients in the same room', async () => {
    const a = await connect(wsUrl, driverToken);
    const b = await connect(wsUrl, dispatcherToken);
    try {
      await subscribe(a, `run:${runId}`);
      await subscribe(b, `run:${runId}`);
      const forA = nextMessage(a);
      const forB = nextMessage(b);
      await request(app).post(`/api/v1/runs/${runId}/gps`).set('Authorization', `Bearer ${driverToken}`).send({ positions: [{ latitude: 51.8, longitude: -0.09 }] });
      const [msgA, msgB] = await Promise.all([forA, forB]);
      expect(msgA.type).toBe('gps:position');
      expect(msgB.type).toBe('gps:position');
      expect(msgA.data).toMatchObject({ runId });
      expect(msgB.data).toMatchObject({ runId });
    } finally {
      a.close();
      b.close();
    }
  });

  it('rejects unknown rooms and malformed messages without dropping the connection', async () => {
    const ws = await connect(wsUrl, driverToken);
    try {
      expect(await subscribe(ws, 'nope:123')).toMatchObject({ type: 'error', code: 'UNKNOWN_ROOM' });
      const bad = nextMessage(ws);
      ws.send('this is not json');
      expect(await bad).toMatchObject({ type: 'error', code: 'BAD_MESSAGE' });

      const ack = await subscribe(ws, `run:${runId}`);
      expect(ack).toMatchObject({ type: 'subscribed' });
    } finally {
      ws.close();
    }
  });
});
