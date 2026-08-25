ALTER TABLE "shipment_events" ADD COLUMN "device_id" uuid;
ALTER TABLE "shipment_events" ADD COLUMN "op_id" uuid;
ALTER TABLE "shipment_events" ADD COLUMN "operator_id" text;
DROP INDEX IF EXISTS "shipment_events_shipment_occurred_unique";
CREATE INDEX "shipment_events_shipment_occurred_idx" ON "shipment_events" USING btree ("shipment_id","occurred_at");
CREATE UNIQUE INDEX "shipment_events_device_op_unique" ON "shipment_events" USING btree ("device_id","op_id");
CREATE UNIQUE INDEX "sync_ledger_device_op_unique" ON "sync_ledger" USING btree ("device_id","op_id");
