-- Daily Neuron-usage reconciliation (TRD §3.5) — see src/server/cron.ts and
-- docs/adding-a-route.md for why this is hand-written, not `drizzle-kit generate` output.

CREATE TABLE `neuron_calibration` (
	`day` text PRIMARY KEY NOT NULL,
	`estimated_neurons` integer NOT NULL,
	`real_request_count` integer NOT NULL,
	`real_input_tokens` integer NOT NULL,
	`real_output_tokens` integer NOT NULL,
	`reconciled_at` integer NOT NULL
);
