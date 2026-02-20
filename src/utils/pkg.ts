import * as fs from 'fs';
import * as path from 'path';
import { Change, MigrationContext } from '../types';

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export function readPackageJson(projectPath: string): PackageJson {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}`);
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PackageJson;
}

export function writePackageJson(projectPath: string, pkg: PackageJson): void {
  const pkgPath = path.join(projectPath, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

export function detectAngularVersion(projectPath: string): number {
  const pkg = readPackageJson(projectPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const version = deps['@angular/core'];
  if (!version) {
    throw new Error('@angular/core not found in dependencies');
  }
  const match = version.match(/(\d+)/);
  if (!match) {
    throw new Error(`Cannot parse Angular version from: ${version}`);
  }
  return parseInt(match[1], 10);
}

/**
 * Replace one package with another across all dependency sections.
 * If oldName exists, removes it and adds newName with newVersion.
 * If oldName doesn't exist, does nothing (package not used in this project).
 */
export function replacePackageDependency(
  ctx: MigrationContext,
  oldName: string,
  newName: string,
  newVersion: string
): Change[] {
  if (ctx.skipPackageJson) return [];

  const pkg = readPackageJson(ctx.projectPath);
  const changes: Change[] = [];
  const sections: Array<keyof PackageJson> = ['dependencies', 'devDependencies', 'peerDependencies'];

  for (const section of sections) {
    const deps = pkg[section] as Record<string, string> | undefined;
    if (!deps || !(oldName in deps)) continue;

    const oldVersion = deps[oldName];
    delete deps[oldName];
    deps[newName] = newVersion;
    changes.push({
      file: 'package.json',
      description: `${section}: replaced ${oldName} (${oldVersion}) with ${newName} (${newVersion})`,
    });
  }

  if (changes.length > 0 && !ctx.dryRun) {
    writePackageJson(ctx.projectPath, pkg);
  }

  return changes;
}

/**
 * Update package versions in all dependency sections.
 * Only updates if the package is already present.
 */
export function updatePackageVersions(
  ctx: MigrationContext,
  updates: Record<string, string>
): Change[] {
  if (ctx.skipPackageJson) {
    ctx.logger.info('Skipping package.json version updates (--skip-package-json)');
    return [];
  }

  const pkg = readPackageJson(ctx.projectPath);
  const changes: Change[] = [];
  const sections: Array<keyof PackageJson> = ['dependencies', 'devDependencies', 'peerDependencies'];

  for (const section of sections) {
    const deps = pkg[section] as Record<string, string> | undefined;
    if (!deps) continue;

    for (const [name, newVersion] of Object.entries(updates)) {
      if (name in deps) {
        const oldVersion = deps[name];
        if (oldVersion !== newVersion) {
          deps[name] = newVersion;
          changes.push({
            file: 'package.json',
            description: `${section}: ${name} ${oldVersion} → ${newVersion}`,
            before: oldVersion,
            after: newVersion,
          });
        }
      }
    }
  }

  if (changes.length > 0 && !ctx.dryRun) {
    writePackageJson(ctx.projectPath, pkg);
  }

  return changes;
}
