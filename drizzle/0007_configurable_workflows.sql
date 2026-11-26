CREATE TABLE `workflow_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`target_id` text NOT NULL,
	`target_name` text,
	`workflow_id` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_assignments_target` ON `workflow_assignments` (`scope`,`target_id`);--> statement-breakpoint
CREATE INDEX `workflow_assignments_workflow` ON `workflow_assignments` (`workflow_id`);--> statement-breakpoint
CREATE TABLE `workflow_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`default_workflow_id` text DEFAULT 'default' NOT NULL,
	`label_conflict_policy` text DEFAULT 'block' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`definition_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_unique` ON `workflow_versions` (`workflow_id`,`version`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`category` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`definition_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_name_unique` ON `workflows` (`name`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `workflow_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `workflow_version` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `workflow_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `workflow_resolution_json` text;--> statement-breakpoint
ALTER TABLE `stage_executions` ADD `gate_json` text;--> statement-breakpoint
ALTER TABLE `stage_executions` ADD `route_json` text;