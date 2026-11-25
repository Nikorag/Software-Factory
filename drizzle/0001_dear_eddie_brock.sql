CREATE TABLE `linear_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`done_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `linear_outbox_idem` ON `linear_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `linear_outbox_status_idx` ON `linear_outbox` (`status`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `autonomous` integer DEFAULT false NOT NULL;