CREATE TABLE `pr_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`path` text,
	`line` integer,
	`url` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_feedback_external` ON `pr_feedback` (`job_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `pr_feedback_job_status` ON `pr_feedback` (`job_id`,`status`);