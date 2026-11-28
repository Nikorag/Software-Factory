CREATE TABLE `lessons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`source` text NOT NULL,
	`source_job_id` text,
	`hits` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lessons_project_status_idx` ON `lessons` (`project_id`,`status`);
