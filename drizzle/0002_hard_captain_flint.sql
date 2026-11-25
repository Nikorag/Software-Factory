CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_job_path_sha` ON `artifacts` (`job_id`,`path`,`sha256`);--> statement-breakpoint
CREATE INDEX `artifacts_job_idx` ON `artifacts` (`job_id`);