# Offline-first with PGlite shared schema

We chose an offline-first architecture: the same Drizzle schema (pg dialect) runs on the server (PostgreSQL) and in-browser on devices via PGlite, and the client mirrors data locally for offline operation. Sync is orchestrated by a dedicated `sync` module that is the **sole writer** applying device operations to server tables. We picked this because drivers and hubs operate in dead zones, so offline-edit-and-sync-later is the only way they stay productive.

This is hard to reverse because it shapes the schema layout (per-module files stitched into one client bundle), the ID strategy (online server-assigned bookings, offline client UUIDv7), and the entire sync protocol. A future reader might otherwise "simplify" the browser database away — but it is load-bearing. The client is a controlled, captive device mirror, never a parallel authority.

Considered: server-only with optimistic UI. Rejected because it cannot function in dead zones. Considered: full CRDT multi-writer — rejected as overengineered; a single server writer with field locks and last-write-wins for free fields is sufficient.