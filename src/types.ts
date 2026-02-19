export interface MigrationContext {
  projectPath: string;
  fromVersion: number;
  toVersion: number;
  dryRun: boolean;
  logger: Logger;
}

export interface MigrationResult {
  step: string;
  changes: Change[];
  warnings: Warning[];
  errors: MigrationError[];
}

export interface Change {
  file: string;
  description: string;
  before?: string;
  after?: string;
}

export interface Warning {
  file: string;
  message: string;
  line?: number;
}

export interface MigrationError {
  file: string;
  message: string;
}

export interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  step(message: string): void;
  change(file: string, description: string): void;
}

export interface MigrationStep {
  from: number;
  to: number;
  name: string;
  run(ctx: MigrationContext): Promise<MigrationResult>;
}
