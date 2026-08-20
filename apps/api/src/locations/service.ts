import { eq } from 'drizzle-orm';

import { hubs, pickupLocations, zones } from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

import { geocodeAddress } from './geocode.js';

// ---------------------------------------------------------------------------
// Hubs
// ---------------------------------------------------------------------------

export async function listHubs(db: Db) {
  return db.query.hubs.findMany({ orderBy: (t, { asc }) => [asc(t.name)] });
}

export async function createHub(
  db: Db,
  ctx: AuthContext,
  input: { name: string; code: string; address: string },
) {
  const existing = await db.query.hubs.findFirst({
    where: (t, { eq }) => eq(t.code, input.code),
  });
  if (existing) throw conflict('CONFLICT', 'Hub code already exists');

  const coords = await geocodeAddress(input.address);

  const [hub] = await db
    .insert(hubs)
    .values({
      name: input.name,
      code: input.code,
      address: input.address,
      ...(coords && { location: { x: coords.lng, y: coords.lat } }),
    })
    .returning();
  if (!hub) throw new Error('createHub: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'hub.create',
    entityType: 'hub',
    entityId: hub.id,
  });

  return hub;
}

export async function updateHub(
  db: Db,
  ctx: AuthContext,
  hubId: string,
  input: { name?: string; code?: string; address?: string; isActive?: boolean },
) {
  if (input.code) {
    const dup = await db.query.hubs.findFirst({
      where: (t, { eq, and, ne }) => and(eq(t.code, input.code!), ne(t.id, hubId)),
    });
    if (dup) throw conflict('CONFLICT', 'Hub code already exists');
  }

  const existing = await db.query.hubs.findFirst({
    where: (t, { eq }) => eq(t.id, hubId),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Hub not found');

  const addressChanged = input.address !== undefined && input.address !== existing.address;
  const coords = addressChanged ? await geocodeAddress(input.address!) : null;

  const [hub] = await db
    .update(hubs)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.code !== undefined && { code: input.code }),
      ...(input.address !== undefined && { address: input.address }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(addressChanged && {
        ...(coords
          ? { location: { x: coords.lng, y: coords.lat } }
          : { location: null }),
      }),
    })
    .where(eq(hubs.id, hubId))
    .returning();
  if (!hub) throw new Error('updateHub: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'hub.update',
    entityType: 'hub',
    entityId: hub.id,
  });

  return hub;
}

export async function deleteHub(db: Db, ctx: AuthContext, hubId: string) {
  const existing = await db.query.hubs.findFirst({
    where: (t, { eq }) => eq(t.id, hubId),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Hub not found');

  const [hub] = await db
    .update(hubs)
    .set({ isActive: false })
    .where(eq(hubs.id, hubId))
    .returning();
  if (!hub) throw new Error('deleteHub: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'hub.delete',
    entityType: 'hub',
    entityId: hub.id,
  });

  return hub;
}

// ---------------------------------------------------------------------------
// Pickup locations
// ---------------------------------------------------------------------------

export async function listPickupLocations(db: Db) {
  return db.query.pickupLocations.findMany({ orderBy: (t, { asc }) => [asc(t.name)] });
}

export async function createPickupLocation(
  db: Db,
  ctx: AuthContext,
  input: { hubId?: string | null; name: string; address: string },
) {
  if (input.hubId) {
    const hub = await db.query.hubs.findFirst({
      where: (t, { eq }) => eq(t.id, input.hubId!),
    });
    if (!hub) throw badRequest('VALIDATION', 'Hub not found');
  }

  const coords = await geocodeAddress(input.address);

  const [loc] = await db
    .insert(pickupLocations)
    .values({
      hubId: input.hubId ?? null,
      name: input.name,
      address: input.address,
      ...(coords && { location: { x: coords.lng, y: coords.lat } }),
    })
    .returning();
  if (!loc) throw new Error('createPickupLocation: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'pickup_location.create',
    entityType: 'pickup_location',
    entityId: loc.id,
  });

  return loc;
}

export async function updatePickupLocation(
  db: Db,
  ctx: AuthContext,
  locationId: string,
  input: { hubId?: string | null; name?: string; address?: string; isActive?: boolean },
) {
  const existing = await db.query.pickupLocations.findFirst({
    where: (t, { eq }) => eq(t.id, locationId),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Pickup location not found');

  if (input.hubId) {
    const hub = await db.query.hubs.findFirst({
      where: (t, { eq }) => eq(t.id, input.hubId!),
    });
    if (!hub) throw badRequest('VALIDATION', 'Hub not found');
  }

  const addressChanged = input.address !== undefined && input.address !== existing.address;
  const coords = addressChanged ? await geocodeAddress(input.address!) : null;

  const [loc] = await db
    .update(pickupLocations)
    .set({
      ...(input.hubId !== undefined && { hubId: input.hubId }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.address !== undefined && { address: input.address }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(addressChanged && {
        ...(coords
          ? { location: { x: coords.lng, y: coords.lat } }
          : { location: null }),
      }),
    })
    .where(eq(pickupLocations.id, locationId))
    .returning();
  if (!loc) throw new Error('updatePickupLocation: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'pickup_location.update',
    entityType: 'pickup_location',
    entityId: loc.id,
  });

  return loc;
}

export async function deletePickupLocation(db: Db, ctx: AuthContext, locationId: string) {
  const existing = await db.query.pickupLocations.findFirst({
    where: (t, { eq }) => eq(t.id, locationId),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Pickup location not found');

  const [loc] = await db
    .update(pickupLocations)
    .set({ isActive: false })
    .where(eq(pickupLocations.id, locationId))
    .returning();
  if (!loc) throw new Error('deletePickupLocation: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'pickup_location.delete',
    entityType: 'pickup_location',
    entityId: loc.id,
  });

  return loc;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export async function listZones(db: Db) {
  return db.query.zones.findMany({ orderBy: (t, { asc }) => [asc(t.name)] });
}

export async function createZone(
  db: Db,
  ctx: AuthContext,
  input: { hubId: string; name: string; description?: string | null },
) {
  const hub = await db.query.hubs.findFirst({
    where: (t, { eq }) => eq(t.id, input.hubId),
  });
  if (!hub) throw badRequest('VALIDATION', 'Hub not found');

  const existing = await db.query.zones.findFirst({
    where: (t, { and, eq }) => and(eq(t.hubId, input.hubId), eq(t.name, input.name)),
  });
  if (existing) throw conflict('CONFLICT', 'Zone name already exists for this hub');

  const [zone] = await db
    .insert(zones)
    .values({
      hubId: input.hubId,
      name: input.name,
      description: input.description ?? null,
    })
    .returning();
  if (!zone) throw new Error('createZone: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'zone.create',
    entityType: 'zone',
    entityId: zone.id,
  });

  return zone;
}

export async function updateZone(
  db: Db,
  ctx: AuthContext,
  zoneId: string,
  input: { name?: string; description?: string | null; isActive?: boolean },
) {
  const existing = await db.query.zones.findFirst({
    where: (t, { eq }) => eq(t.id, zoneId),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Zone not found');

  if (input.name && input.name !== existing.name) {
    const dup = await db.query.zones.findFirst({
      where: (t, { and, eq, ne }) =>
        and(eq(t.hubId, existing.hubId), eq(t.name, input.name!), ne(t.id, zoneId)),
    });
    if (dup) throw conflict('CONFLICT', 'Zone name already exists for this hub');
  }

  const [zone] = await db
    .update(zones)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    })
    .where(eq(zones.id, zoneId))
    .returning();
  if (!zone) throw new Error('updateZone: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'zone.update',
    entityType: 'zone',
    entityId: zone.id,
  });

  return zone;
}

export async function deleteZone(db: Db, ctx: AuthContext, zoneId: string) {
  const existing = await db.query.zones.findFirst({
    where: (t, { eq }) => eq(t.id, zoneId),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Zone not found');

  const [zone] = await db
    .update(zones)
    .set({ isActive: false })
    .where(eq(zones.id, zoneId))
    .returning();
  if (!zone) throw new Error('deleteZone: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'zone.delete',
    entityType: 'zone',
    entityId: zone.id,
  });

  return zone;
}

// ---------------------------------------------------------------------------
// Public reads (active only, minimal fields, no coordinates)
// ---------------------------------------------------------------------------

export async function listActiveHubs(db: Db) {
  return db.query.hubs.findMany({
    where: (t, { eq }) => eq(t.isActive, true),
    columns: { id: true, name: true, code: true, address: true },
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

export async function listActivePickupLocations(db: Db) {
  return db.query.pickupLocations.findMany({
    where: (t, { eq }) => eq(t.isActive, true),
    columns: { id: true, name: true, address: true, hubId: true },
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

export async function listActiveZones(db: Db) {
  return db.query.zones.findMany({
    where: (t, { eq }) => eq(t.isActive, true),
    columns: { id: true, name: true, hubId: true, description: true },
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}
