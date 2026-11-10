CREATE TABLE `access_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`project` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_access` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
