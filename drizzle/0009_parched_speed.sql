CREATE TABLE `permission_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`stage` text NOT NULL,
	`tool` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`grant_path` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`decided_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_requests_once` ON `permission_requests` (`job_id`,`kind`,`grant_path`);