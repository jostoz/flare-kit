CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `name` text,
  `password_hash` text,
  `stripe_customer_id` text,
  `created_at` integer NOT NULL
);
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);
CREATE UNIQUE INDEX `users_stripe_customer_idx` ON `users` (`stripe_customer_id`);

CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `expires_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);

CREATE TABLE `stripe_events` (
  `id` text PRIMARY KEY NOT NULL,
  `processed_at` integer NOT NULL
);

CREATE TABLE `ai_usage` (
  `user_id` text NOT NULL,
  `day` text NOT NULL,
  `neurons` integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX `ai_usage_user_day_idx` ON `ai_usage` (`user_id`, `day`);
