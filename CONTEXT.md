# Logistics

The offline-first logistics platform: senders book packages, drivers deliver on run-sheets through dead zones, and everything converges server-side. This context covers the shared vocabulary used across the platform's modules and the six client interfaces.

## Language

### Actors & identity

**User**:
An account in the system, identified by email and password.
_Avoid_: account, login

**Role**:
A grant of capabilities that a User holds. A single User can hold multiple Roles.
_Avoid_: permission group

**Customer**:
A User who sends or receives packages through the platform.
_Avoid_: client, buyer

**Sender**:
The party dispatching a Shipment.

**Recipient**:
The party receiving a Shipment. Identified by name, email, and phone captured at Booking.
_Avoid_: consignee

**Merchant**:
A business User who creates Shipments and manages orders, usually for fulfillment.
_Avoid_: seller, vendor

**Driver**:
A User who delivers the Shipments on an assigned Run-sheet.
_Avoid_: rider, courier

**Dispatcher**:
A User who groups queued Shipments into Runs and assigns them to Drivers.

**Branch Operator**:
Staff at a Hub who handles drop-off, pickup, and COD Deposits.

**Admin**:
A User who controls the whole network: users, roles, pricing, locations, payments, reports.

### Addressing & zones

**Zone**:
A named catchment area around a Hub, selected at Booking to determine price.
_Avoid_: district, region, service area

**Pick-a-zone**:
The act of choosing a Recipient's Zone from a dropdown at Booking instead of geocoding.

**Hub**:
A company-operated logistics facility for sorting, holding, and package pickup/drop-off.

**Pickup Location**:
A designated point — a Hub or partner site — where packages are dropped off or collected.
_Avoid_: drop point

**Address**:
Free-form text plus a Zone, optionally referencing a Hub or Pickup Location.
_Avoid_: location

### Shipments

**Shipment**:
A package delivery task from a Sender to a Recipient, defined by pickup, destination, and delivery service.
_Avoid_: order, parcel

**Package**:
One physical item within a Shipment; a Shipment contains one or more Packages.

**Draft**:
An unbooked Shipment with a local price estimate, creatable offline.

**Booking**:
The online, server-confirmed creation of a Shipment.
_Avoid_: order placement

**Size Class**:
The S/M/L/XL grouping of a Package used by pricing.
_Avoid_: dimensions

**Weight Class**:
The weight range of a Package used by pricing.

**Category**:
The classification of what a Package contains.

**Delivery Option**:
The service level and destination handling chosen for a Shipment: standard, express, same-day, scheduled, pickup-at-location, drop-off-at-location.
_Avoid_: delivery speed, shipping speed

**Special Instructions**:
Free-form notes on a Shipment intended for the Driver.

**Quote**:
The price computed for a Shipment's route, Package, and Delivery Option.

**Quote Snapshot**:
The price fixed at Booking; later pricing changes never retroactively change it.

**Field Lock**:
The state in which a Shipment's mutable fields are frozen while it is on an active Run-sheet.
_Avoid_: freeze

### Tracking & state

**Shipment Status**:
The current state of a Shipment in its lifecycle (DRAFT, BOOKED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED_ATTEMPT, RETURNING, RETURNED, CANCELLED).
_Avoid_: state, delivery status

**Shipment Event**:
An immutable record appended whenever a Shipment's Status changes or it is scanned, carrying actor, location, and timestamp.

**Position**:
A GPS location point captured from a Driver's device while on an active Run.
_Avoid_: track event

### Money

**COD**:
Payment collected at delivery, either cash or card.
_Avoid_: cash on delivery expansion

**Collection**:
The COD amount taken at delivery by a Driver.

**Deposit**:
A Collection handed to a Branch cashier at a Hub.
_Avoid_: drop

**Reconciliation**:
The matching of Deposits against Collections to confirm money is accounted for.

**Settlement**:
The transfer owed to a Merchant or the company, expressed in the Functional Currency.

**Dispute**:
A contested Collection, handled through an audited path separate from normal Settlement.

**Functional Currency**:
The single reporting currency configured by Admin; Collections may be in any supported currency and are converted at Reconciliation.
_Avoid_: base currency, reporting currency

**Money**:
An amount together with its currency, stored as integer minor units.
_Avoid_: price, cost, amount

### Delivery & operations

**Run**:
A group of Shipments assigned to a Driver for one shift.
_Avoid_: route

**Run-sheet**:
The set of Shipments and their delivery order belonging to a Driver's Run, available offline.
_Avoid_: manifest

### Offline & synchronization

**Device**:
A browser or installable web instance holding a local mirror of the schema for offline operation.

**Sync Ledger**:
The ordered list of local mutations on a Device awaiting upload.
_Avoid_: queue

**Sync Op**:
One entry in the Sync Ledger, carrying an idempotency key.

**Sequence (seq)**:
The per-Device monotonic counter that orders Sync Ops.

**Offset**:
The last server-acknowledged Sequence position; a Device resumes from it after reconnect.

**Static Reference**:
Server-distributed tables (pricing rules, Hubs, Zones, Driver rosters) that Devices refresh.
_Avoid_: lookup table
