import { eq } from 'drizzle-orm';

import { addresses, customerProfiles, emergencyContacts } from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import type { Db } from '../../shared/db.js';
import { conflict, notFound } from '../../shared/errors.js';

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getProfile(db: Db, userId: string) {
  const profile = await db.query.customerProfiles.findFirst({
    where: (t, { eq }) => eq(t.userId, userId),
  });
  if (!profile) throw notFound('NOT_FOUND', 'No customer profile');
  return profile;
}

export async function createProfile(db: Db, ctx: AuthContext, phone?: string | null) {
  const existing = await db.query.customerProfiles.findFirst({
    where: (t, { eq }) => eq(t.userId, ctx.userId),
  });
  if (existing) throw conflict('CONFLICT', 'Customer profile already exists');

  const [profile] = await db
    .insert(customerProfiles)
    .values({ userId: ctx.userId, phone: phone ?? null })
    .returning();
  if (!profile) throw new Error('createProfile: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'customer.profile.create',
    entityType: 'customer_profile',
    entityId: profile.id,
  });

  return profile;
}

export async function updateProfile(db: Db, ctx: AuthContext, phone: string | null) {
  const [profile] = await db
    .update(customerProfiles)
    .set({ phone, updatedAt: new Date() })
    .where(eq(customerProfiles.userId, ctx.userId))
    .returning();
  if (!profile) throw notFound('NOT_FOUND', 'No customer profile');

  await writeAudit(db, ctx, {
    action: 'customer.profile.update',
    entityType: 'customer_profile',
    entityId: profile.id,
  });

  return profile;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

async function loadCustomerProfile(db: Db, userId: string) {
  const profile = await db.query.customerProfiles.findFirst({
    where: (t, { eq }) => eq(t.userId, userId),
  });
  if (!profile) throw notFound('NOT_FOUND', 'No customer profile');
  return profile;
}

export async function listAddresses(db: Db, userId: string) {
  const profile = await loadCustomerProfile(db, userId);
  return db.query.addresses.findMany({
    where: (t, { eq }) => eq(t.customerId, profile.id),
    orderBy: (t, { desc }) => [desc(t.isDefault), desc(t.createdAt)],
  });
}

export async function createAddress(
  db: Db,
  ctx: AuthContext,
  input: {
    label: string;
    line1: string;
    line2?: string | null;
    city: string;
    zoneId?: string | null;
    hubId?: string | null;
    pickupLocationId?: string | null;
    isDefault?: boolean;
  },
) {
  const profile = await loadCustomerProfile(db, ctx.userId);

  if (input.isDefault) {
    await db
      .update(addresses)
      .set({ isDefault: false })
      .where(eq(addresses.customerId, profile.id));
  }

  const [address] = await db
    .insert(addresses)
    .values({
      customerId: profile.id,
      label: input.label,
      line1: input.line1,
      line2: input.line2 ?? null,
      city: input.city,
      zoneId: input.zoneId ?? null,
      hubId: input.hubId ?? null,
      pickupLocationId: input.pickupLocationId ?? null,
      isDefault: input.isDefault ?? false,
    })
    .returning();
  if (!address) throw new Error('createAddress: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'customer.address.create',
    entityType: 'address',
    entityId: address.id,
  });

  return address;
}

export async function updateAddress(
  db: Db,
  ctx: AuthContext,
  addressId: string,
  input: {
    label?: string;
    line1?: string;
    line2?: string | null;
    city?: string;
    zoneId?: string | null;
    hubId?: string | null;
    pickupLocationId?: string | null;
    isDefault?: boolean;
  },
) {
  const profile = await loadCustomerProfile(db, ctx.userId);

  const existing = await db.query.addresses.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.id, addressId), eq(t.customerId, profile.id)),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Address not found');

  if (input.isDefault) {
    await db
      .update(addresses)
      .set({ isDefault: false })
      .where(eq(addresses.customerId, profile.id));
  }

  const [address] = await db
    .update(addresses)
    .set({
      ...(input.label !== undefined && { label: input.label }),
      ...(input.line1 !== undefined && { line1: input.line1 }),
      ...(input.line2 !== undefined && { line2: input.line2 }),
      ...(input.city !== undefined && { city: input.city }),
      ...(input.zoneId !== undefined && { zoneId: input.zoneId }),
      ...(input.hubId !== undefined && { hubId: input.hubId }),
      ...(input.pickupLocationId !== undefined && { pickupLocationId: input.pickupLocationId }),
      ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
    })
    .where(eq(addresses.id, addressId))
    .returning();
  if (!address) throw new Error('updateAddress: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'customer.address.update',
    entityType: 'address',
    entityId: address.id,
  });

  return address;
}

export async function deleteAddress(db: Db, ctx: AuthContext, addressId: string) {
  const profile = await loadCustomerProfile(db, ctx.userId);

  const existing = await db.query.addresses.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.id, addressId), eq(t.customerId, profile.id)),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Address not found');

  await db.delete(addresses).where(eq(addresses.id, addressId));

  await writeAudit(db, ctx, {
    action: 'customer.address.delete',
    entityType: 'address',
    entityId: addressId,
  });
}

// ---------------------------------------------------------------------------
// Emergency contacts
// ---------------------------------------------------------------------------

export async function listEmergencyContacts(db: Db, userId: string) {
  const profile = await loadCustomerProfile(db, userId);
  return db.query.emergencyContacts.findMany({
    where: (t, { eq }) => eq(t.customerId, profile.id),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

export async function createEmergencyContact(
  db: Db,
  ctx: AuthContext,
  input: { name: string; phone: string; email?: string | null; relationship: string },
) {
  const profile = await loadCustomerProfile(db, ctx.userId);

  const [contact] = await db
    .insert(emergencyContacts)
    .values({
      customerId: profile.id,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      relationship: input.relationship,
    })
    .returning();
  if (!contact) throw new Error('createEmergencyContact: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'customer.emergency_contact.create',
    entityType: 'emergency_contact',
    entityId: contact.id,
  });

  return contact;
}

export async function updateEmergencyContact(
  db: Db,
  ctx: AuthContext,
  contactId: string,
  input: { name?: string; phone?: string; email?: string | null; relationship?: string },
) {
  const profile = await loadCustomerProfile(db, ctx.userId);

  const existing = await db.query.emergencyContacts.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.id, contactId), eq(t.customerId, profile.id)),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Emergency contact not found');

  const [contact] = await db
    .update(emergencyContacts)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.phone !== undefined && { phone: input.phone }),
      ...(input.email !== undefined && { email: input.email }),
      ...(input.relationship !== undefined && { relationship: input.relationship }),
    })
    .where(eq(emergencyContacts.id, contactId))
    .returning();
  if (!contact) throw new Error('updateEmergencyContact: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'customer.emergency_contact.update',
    entityType: 'emergency_contact',
    entityId: contact.id,
  });

  return contact;
}

export async function deleteEmergencyContact(db: Db, ctx: AuthContext, contactId: string) {
  const profile = await loadCustomerProfile(db, ctx.userId);

  const existing = await db.query.emergencyContacts.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.id, contactId), eq(t.customerId, profile.id)),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Emergency contact not found');

  await db.delete(emergencyContacts).where(eq(emergencyContacts.id, contactId));

  await writeAudit(db, ctx, {
    action: 'customer.emergency_contact.delete',
    entityType: 'emergency_contact',
    entityId: contactId,
  });
}
