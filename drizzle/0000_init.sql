CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`note` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approvals_task_idx` ON `approvals` (`task_id`);--> statement-breakpoint
CREATE TABLE `context_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`content` text NOT NULL,
	`include_in_prompts` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_docs_project_idx` ON `context_docs` (`project_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`title` text NOT NULL,
	`decision` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decisions_project_idx` ON `decisions` (`project_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`body` text NOT NULL,
	`payload` text,
	`refs` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_task_idx` ON `messages` (`task_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`repo_path` text NOT NULL,
	`github_url` text,
	`product_goals` text DEFAULT '' NOT NULL,
	`user_requirements` text DEFAULT '' NOT NULL,
	`architecture` text DEFAULT '' NOT NULL,
	`constraints` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`memory_summary` text DEFAULT '' NOT NULL,
	`settings` text NOT NULL,
	`path_verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);--> statement-breakpoint
CREATE TABLE `provider_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`project_id` text,
	`provider` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`error_kind` text,
	`error` text,
	`exit_code` integer,
	`duration_ms` integer,
	`usage` text,
	`stdout_excerpt` text,
	`stderr_excerpt` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `provider_runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`request` text NOT NULL,
	`status` text NOT NULL,
	`paused_from` text,
	`spec` text,
	`spec_approved_at` text,
	`revision_round` integer DEFAULT 0 NOT NULL,
	`max_revisions` integer DEFAULT 2 NOT NULL,
	`auto_advance` integer DEFAULT true NOT NULL,
	`branch` text,
	`base_ref` text,
	`base_commit` text,
	`worktree_path` text,
	`last_error` text,
	`last_error_kind` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE TABLE `transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transitions_task_idx` ON `transitions` (`task_id`);