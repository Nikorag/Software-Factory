CREATE TABLE `agent_invocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`stage_execution_id` integer,
	`agent` text NOT NULL,
	`model` text,
	`cwd` text,
	`exit_code` integer,
	`duration_ms` integer,
	`usage_json` text,
	`log_path` text,
	`started_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stage_execution_id`) REFERENCES `stage_executions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text,
	`kind` text NOT NULL,
	`decision` text NOT NULL,
	`rationale` text,
	`actor` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `factory_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`emergency_stop` integer DEFAULT false NOT NULL,
	`reason` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_key` text NOT NULL,
	`workflow` text DEFAULT 'feature' NOT NULL,
	`stage` text DEFAULT 'DISCOVERED' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`remediation_attempts` integer DEFAULT 0 NOT NULL,
	`stage_attempts` integer DEFAULT 0 NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`dry_run` integer DEFAULT false NOT NULL,
	`pr_url` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_one_active_per_issue` ON `jobs` (`project_id`,`external_id`) WHERE status in ('queued','running','waiting');--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`last_validated_at` integer,
	`validation_json` text
);
--> statement-breakpoint
CREATE TABLE `stage_executions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`stage` text NOT NULL,
	`attempt` integer NOT NULL,
	`outcome` text NOT NULL,
	`input_json` text,
	`output_json` text,
	`error` text,
	`idempotency_key` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stage_exec_idem` ON `stage_executions` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`job_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);