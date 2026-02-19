import chalk from 'chalk';
import { Logger } from '../types';

export class ConsoleLogger implements Logger {
  private readonly changes: Array<{ file: string; description: string }> = [];
  private readonly warnings: string[] = [];

  info(message: string): void {
    console.log(chalk.blue('  ℹ ') + message);
  }

  success(message: string): void {
    console.log(chalk.green('  ✓ ') + message);
  }

  warn(message: string): void {
    console.log(chalk.yellow('  ⚠ ') + message);
    this.warnings.push(message);
  }

  error(message: string): void {
    console.log(chalk.red('  ✗ ') + message);
  }

  step(message: string): void {
    console.log(chalk.cyan('\n▶ ') + chalk.bold(message));
  }

  change(file: string, description: string): void {
    const shortFile = file.length > 60 ? '...' + file.slice(-57) : file;
    console.log(chalk.green('    ↳ ') + chalk.dim(shortFile) + chalk.gray(' — ') + description);
    this.changes.push({ file, description });
  }
}
