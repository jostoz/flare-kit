-- Conversation memory for /api/ai/chat (see docs/adding-a-route.md for why
-- this is hand-written, not `drizzle-kit generate` output).

CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX `messages_user_created_idx` ON `messages` (`user_id`, `created_at`);
