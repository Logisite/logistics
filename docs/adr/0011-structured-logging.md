# Structured logging with Pino, per-deployment retention

We replace `console.*` with `pino` JSON logs, one logger per `apps/api` deployment, request-scoped child loggers carrying `requestId` and `operatorId`. No log ever leaves its deployment's stream; per-operator DB isolation mirrors per-operator log isolation.

We chose `pino` over Winston/Bunyan because it is ~2.4x faster in official benchmarks (115ms vs 270ms per 10k logs) and defers formatting to a worker thread, so GPS batches and sync FIFO do not pay logging cost on the request. It is hard to reverse because every handler will call `req.log` and every future observability decision (OTel tail sampling, OTLP collector) assumes JSON lines with `operatorId`. It is surprising because the cheapest white-label isolation is not code — it is a deployment boundary with a log stream attached.
