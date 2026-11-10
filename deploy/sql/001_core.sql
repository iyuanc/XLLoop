CREATE DATABASE IF NOT EXISTS `xlloop`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE `xlloop`;

CREATE TABLE IF NOT EXISTS `project_state` (
  `id` VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  `payload` LONGTEXT NOT NULL,
  `revision` INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `agent_state` (
  `id` VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  `payload` LONGTEXT NOT NULL,
  `revision` INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `autonomy_state` (
  `id` VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  `payload` LONGTEXT NOT NULL,
  `revision` INT UNSIGNED NOT NULL DEFAULT 1,
  `lease_until` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `autonomy_archive` (
  `id` VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  `payload` LONGTEXT NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `workspace_access` (
  `id` VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  `payload` LONGTEXT NOT NULL,
  `revision` INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `access_audit` (
  `id` CHAR(36) NOT NULL,
  `actor` VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  `project` VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  `action` VARCHAR(255) NOT NULL,
  `outcome` VARCHAR(255) NOT NULL,
  `at` VARCHAR(40) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_access_audit_project_at` (`project`(191), `at`),
  KEY `idx_access_audit_at` (`at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

