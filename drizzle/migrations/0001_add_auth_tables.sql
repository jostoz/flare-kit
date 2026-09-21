-- better-auth requires `account` and `verification` tables (credential
-- passwords live in accounts.password, not on the user row) plus columns on
-- users/sessions that 0000_init.sql never created — auth was never
-- exercised end-to-end before this. users has 0 rows in production at the
-- time of writing, so no backfill is needed for the new NOT NULL columns.

CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);

CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);

ALTER TABLE `users` ADD `email_verified` integer DEFAULT false NOT NULL;
ALTER TABLE `users` ADD `image` text;
ALTER TABLE `users` ADD `updated_at` integer NOT NULL DEFAULT 0;
ALTER TABLE `users` DROP COLUMN `password_hash`;

ALTER TABLE `sessions` ADD `token` text NOT NULL DEFAULT '';
ALTER TABLE `sessions` ADD `created_at` integer NOT NULL DEFAULT 0;
ALTER TABLE `sessions` ADD `ip_address` text;
ALTER TABLE `sessions` ADD `user_agent` text;
CREATE UNIQUE INDEX `sessions_token_idx` ON `sessions` (`token`);
