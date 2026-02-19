import * as path from 'path';
import * as fs from 'fs';
import {
  Project,
  SourceFile,
  SyntaxKind,
  Node,
} from 'ts-morph';
import { globSync } from 'glob';
import { Change, Warning, MigrationContext } from '../types';

export function createTsProject(projectPath: string): Project {
  const tsConfigPath = path.join(projectPath, 'tsconfig.json');
  const tsConfigAppPath = path.join(projectPath, 'tsconfig.app.json');

  const configFile = fs.existsSync(tsConfigAppPath)
    ? tsConfigAppPath
    : tsConfigPath;

  const project = fs.existsSync(configFile)
    ? new Project({ tsConfigFilePath: configFile, skipAddingFilesFromTsConfig: false })
    : new Project();

  // Always add ALL .ts files explicitly — tsconfig may exclude barrel files,
  // shared modules, or files outside src/ that still need to be migrated.
  const tsFiles = globSync('**/*.ts', {
    cwd: projectPath,
    ignore: ['node_modules/**', 'dist/**'],
    absolute: true,
  });
  project.addSourceFilesAtPaths(tsFiles);

  return project;
}

// ---------------------------------------------------------------------------
// Import transformations
// ---------------------------------------------------------------------------

/**
 * Rename a named import across all source files.
 * e.g. RouterLinkWithHref → RouterLink from '@angular/router'
 */
export function renameNamedImport(
  sourceFiles: SourceFile[],
  moduleName: string,
  oldName: string,
  newName: string,
  ctx: MigrationContext
): Change[] {
  const changes: Change[] = [];

  for (const sf of sourceFiles) {
    let fileChanged = false;

    sf.getImportDeclarations()
      .filter(imp => imp.getModuleSpecifierValue() === moduleName)
      .forEach(imp => {
        const namedImports = imp.getNamedImports();
        namedImports.forEach(ni => {
          if (ni.getName() === oldName) {
            // Rename the import
            ni.setName(newName);
            fileChanged = true;
          }
        });
      });

    // Also rename usages in the file body
    if (fileChanged) {
      sf.getDescendantsOfKind(SyntaxKind.Identifier)
        .filter(id => id.getText() === oldName)
        .filter(id => {
          // Skip the import declaration itself (already renamed)
          const parent = id.getParent();
          return !Node.isImportSpecifier(parent);
        })
        .forEach(id => {
          id.replaceWithText(newName);
        });

      changes.push({
        file: sf.getFilePath(),
        description: `${oldName} → ${newName} (import from '${moduleName}')`,
      });

      if (!ctx.dryRun) {
        sf.saveSync();
      }
    }
  }

  return changes;
}

/**
 * Move a named import from one module to another.
 * e.g. DOCUMENT from '@angular/platform-browser' → '@angular/common'
 */
export function moveImport(
  sourceFiles: SourceFile[],
  symbolName: string,
  fromModule: string,
  toModule: string,
  ctx: MigrationContext
): Change[] {
  const changes: Change[] = [];

  for (const sf of sourceFiles) {
    const oldImport = sf.getImportDeclarations()
      .find(imp => imp.getModuleSpecifierValue() === fromModule &&
        imp.getNamedImports().some(ni => ni.getName() === symbolName));

    if (!oldImport) continue;

    // Remove from old import
    const namedImports = oldImport.getNamedImports();
    if (namedImports.length === 1) {
      oldImport.remove();
    } else {
      const specifier = namedImports.find(ni => ni.getName() === symbolName);
      specifier?.remove();
    }

    // Add to new import (merge with existing or create new)
    const existingNewImport = sf.getImportDeclarations()
      .find(imp => imp.getModuleSpecifierValue() === toModule);

    if (existingNewImport) {
      existingNewImport.addNamedImport(symbolName);
    } else {
      sf.addImportDeclaration({
        namedImports: [symbolName],
        moduleSpecifier: toModule,
      });
    }

    changes.push({
      file: sf.getFilePath(),
      description: `${symbolName}: '${fromModule}' → '${toModule}'`,
    });

    if (!ctx.dryRun) {
      sf.saveSync();
    }
  }

  return changes;
}

/**
 * Remove named imports that no longer exist (with a warning).
 */
export function removeObsoleteImport(
  sourceFiles: SourceFile[],
  moduleName: string,
  symbolName: string,
  ctx: MigrationContext
): { changes: Change[]; warnings: Warning[] } {
  const changes: Change[] = [];
  const warnings: Warning[] = [];

  for (const sf of sourceFiles) {
    const imp = sf.getImportDeclarations()
      .find(d => d.getModuleSpecifierValue() === moduleName &&
        d.getNamedImports().some(ni => ni.getName() === symbolName));

    if (!imp) continue;

    const namedImports = imp.getNamedImports();
    if (namedImports.length === 1) {
      imp.remove();
    } else {
      namedImports.find(ni => ni.getName() === symbolName)?.remove();
    }

    changes.push({
      file: sf.getFilePath(),
      description: `Removed obsolete import '${symbolName}' from '${moduleName}'`,
    });
    warnings.push({
      file: sf.getFilePath(),
      message: `'${symbolName}' was removed from '${moduleName}'. Check usages manually.`,
    });

    if (!ctx.dryRun) {
      sf.saveSync();
    }
  }

  return { changes, warnings };
}

// ---------------------------------------------------------------------------
// Remove symbol from NgModule imports/declarations/exports arrays
// ---------------------------------------------------------------------------

/**
 * Remove a symbol from NgModule imports/declarations/exports arrays.
 * Handles both the import statement AND the usage inside @NgModule decorator.
 *
 * e.g. BrowserTransferStateModule, ServerTransferStateModule
 */
export function removeFromNgModuleArrays(
  sourceFiles: SourceFile[],
  symbolName: string,
  ctx: MigrationContext
): Change[] {
  const changes: Change[] = [];

  for (const sf of sourceFiles) {
    let fileChanged = false;

    sf.getClasses().forEach(cls => {
      cls.getDecorators().forEach(dec => {
        if (dec.getName() !== 'NgModule' && dec.getName() !== 'Component') return;

        const args = dec.getArguments();
        if (args.length === 0) return;

        const arg = args[0];
        if (!Node.isObjectLiteralExpression(arg)) return;

        // Check imports, declarations, exports arrays
        for (const arrayProp of ['imports', 'declarations', 'exports'] as const) {
          const prop = arg.getProperty(arrayProp);
          if (!prop || !Node.isPropertyAssignment(prop)) continue;

          const initializer = prop.getInitializer();
          if (!Node.isArrayLiteralExpression(initializer)) continue;

          const elements = initializer.getElements();
          elements.forEach(el => {
            // Match plain identifier: BrowserTransferStateModule
            if (Node.isIdentifier(el) && el.getText() === symbolName) {
              el.remove();
              fileChanged = true;
              changes.push({
                file: sf.getFilePath(),
                description: `Removed '${symbolName}' from @${dec.getName()} ${arrayProp}[]`,
              });
            }
            // Match call expression: BrowserModule.withServerTransition(...) already handled elsewhere
          });
        }
      });
    });

    if (fileChanged && !ctx.dryRun) {
      sf.saveSync();
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// ComponentFactory / ComponentFactoryResolver migration (v16 → v17)
// ---------------------------------------------------------------------------

/**
 * Remove ComponentFactoryResolver from constructor parameters and class fields.
 * Also migrates ViewContainerRef.createComponent(factory) calls.
 *
 * Before:
 *   constructor(private resolver: ComponentFactoryResolver) {}
 *   const factory = this.resolver.resolveComponentFactory(MyComponent);
 *   vcr.createComponent(factory);
 *
 * After:
 *   vcr.createComponent(MyComponent);
 */
export function migrateComponentFactoryResolver(
  sourceFiles: SourceFile[],
  ctx: MigrationContext
): { changes: Change[]; warnings: Warning[] } {
  const changes: Change[] = [];
  const warnings: Warning[] = [];

  for (const sf of sourceFiles) {
    let fileChanged = false;

    // 1. Remove ComponentFactoryResolver constructor parameters
    sf.getClasses().forEach(cls => {
      cls.getConstructors().forEach(ctor => {
        const params = ctor.getParameters();
        params.forEach(param => {
          const typeNode = param.getTypeNode();
          if (typeNode?.getText() === 'ComponentFactoryResolver') {
            param.remove();
            fileChanged = true;
            warnings.push({
              file: sf.getFilePath(),
              message: `Removed ComponentFactoryResolver constructor param in ${cls.getName() ?? 'anonymous'}. Verify resolveComponentFactory() usages are migrated.`,
            });
          }
        });
      });

      // 2. Remove class fields typed as ComponentFactoryResolver
      cls.getProperties().forEach(prop => {
        const typeNode = prop.getTypeNode();
        if (typeNode?.getText() === 'ComponentFactoryResolver') {
          prop.remove();
          fileChanged = true;
        }
      });
    });

    // 3. Migrate vcr.createComponent(factory) → vcr.createComponent(ComponentType)
    // Find: someVar.resolveComponentFactory(X) calls
    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(call => {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      if (expr.getName() !== 'resolveComponentFactory') return;

      const args = call.getArguments();
      if (args.length !== 1) return;

      const componentTypeText = args[0].getText();

      // Replace the entire resolveComponentFactory(X) call with just X
      // We need to find where this factory variable is used in createComponent
      warnings.push({
        file: sf.getFilePath(),
        message: `Found resolveComponentFactory(${componentTypeText}) — replace vcr.createComponent(factory) with vcr.createComponent(${componentTypeText}) manually or check auto-migration below.`,
      });
    });

    // 4. Migrate createComponent(factory, ...) where factory was resolved
    // This is a heuristic: if createComponent is called with a variable (not a type reference),
    // we warn. If called with a result of resolveComponentFactory directly, we fix.
    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(call => {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      if (expr.getName() !== 'createComponent') return;

      const args = call.getArguments();
      if (args.length === 0) return;

      const firstArg = args[0];
      // If first arg is a call to resolveComponentFactory(X), inline X
      if (Node.isCallExpression(firstArg)) {
        const innerExpr = firstArg.getExpression();
        if (Node.isPropertyAccessExpression(innerExpr) &&
          innerExpr.getName() === 'resolveComponentFactory') {
          const innerArgs = firstArg.getArguments();
          if (innerArgs.length === 1) {
            firstArg.replaceWithText(innerArgs[0].getText());
            fileChanged = true;
            changes.push({
              file: sf.getFilePath(),
              description: `createComponent(resolver.resolveComponentFactory(X)) → createComponent(X)`,
            });
          }
        }
      }
    });

    if (fileChanged && !ctx.dryRun) {
      sf.saveSync();
    }
  }

  return { changes, warnings };
}

// ---------------------------------------------------------------------------
// CanLoad → CanMatch (v16 → v17)
// ---------------------------------------------------------------------------

export function migrateCanLoadToCanMatch(
  sourceFiles: SourceFile[],
  ctx: MigrationContext
): Change[] {
  const changes: Change[] = [];

  for (const sf of sourceFiles) {
    const imp = sf.getImportDeclarations()
      .find(d => d.getModuleSpecifierValue() === '@angular/router' &&
        d.getNamedImports().some(ni => ni.getName() === 'CanLoad'));

    if (!imp) continue;

    let fileChanged = false;

    // Replace CanLoad → CanMatch in import
    imp.getNamedImports()
      .filter(ni => ni.getName() === 'CanLoad')
      .forEach(ni => {
        ni.setName('CanMatch');
        fileChanged = true;
      });

    // Replace CanLoad → CanMatch in implements clause and type usage
    if (fileChanged) {
      sf.getDescendantsOfKind(SyntaxKind.Identifier)
        .filter(id => id.getText() === 'CanLoad')
        .filter(id => !Node.isImportSpecifier(id.getParent()))
        .forEach(id => id.replaceWithText('CanMatch'));

      changes.push({
        file: sf.getFilePath(),
        description: 'CanLoad → CanMatch (removed in Angular 17)',
      });

      if (!ctx.dryRun) {
        sf.saveSync();
      }
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// BrowserModule.withServerTransition (v17 → v18)
// ---------------------------------------------------------------------------

/**
 * Remove BrowserModule.withServerTransition({ appId: '...' }) calls.
 * Replace with just BrowserModule in imports arrays.
 *
 * Before: imports: [BrowserModule.withServerTransition({ appId: 'my-app' })]
 * After:  imports: [BrowserModule]
 */
export function removeBrowserModuleWithServerTransition(
  sourceFiles: SourceFile[],
  ctx: MigrationContext
): Change[] {
  const changes: Change[] = [];

  for (const sf of sourceFiles) {
    let fileChanged = false;

    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(call => {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      if (expr.getName() !== 'withServerTransition') return;

      const obj = expr.getExpression();
      if (obj.getText() !== 'BrowserModule') return;

      // Replace BrowserModule.withServerTransition({...}) → BrowserModule
      call.replaceWithText('BrowserModule');
      fileChanged = true;

      changes.push({
        file: sf.getFilePath(),
        description: 'BrowserModule.withServerTransition() → BrowserModule (removed in Angular 18)',
      });
    });

    if (fileChanged && !ctx.dryRun) {
      sf.saveSync();
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// ModuleWithProviders<T> — ensure generic is present (v13+, strict in v15)
// ---------------------------------------------------------------------------

export function ensureModuleWithProvidersGeneric(
  sourceFiles: SourceFile[],
  ctx: MigrationContext
): { changes: Change[]; warnings: Warning[] } {
  const warnings: Warning[] = [];

  for (const sf of sourceFiles) {
    sf.getDescendantsOfKind(SyntaxKind.TypeReference).forEach(ref => {
      if (ref.getText() === 'ModuleWithProviders' && ref.getTypeArguments().length === 0) {
        warnings.push({
          file: sf.getFilePath(),
          message: 'ModuleWithProviders is missing a generic type parameter. Add ModuleWithProviders<YourModule>',
        });
      }
    });
  }

  return { changes: [], warnings };
}

// ---------------------------------------------------------------------------
// standalone: false migration (v18 → v19)
// ---------------------------------------------------------------------------

/**
 * In Angular 19, standalone defaults to true.
 * Add `standalone: false` to all @Component, @Directive, @Pipe that don't
 * already have the property set — this preserves NgModule-based behavior.
 */
export function addStandaloneFalse(
  sourceFiles: SourceFile[],
  ctx: MigrationContext
): Change[] {
  const changes: Change[] = [];
  const decorators = ['Component', 'Directive', 'Pipe'];

  for (const sf of sourceFiles) {
    let fileChanged = false;

    sf.getClasses().forEach(cls => {
      cls.getDecorators().forEach(dec => {
        if (!decorators.includes(dec.getName())) return;

        const args = dec.getArguments();
        if (args.length === 0) return;

        const arg = args[0];
        if (!Node.isObjectLiteralExpression(arg)) return;

        const hasStandalone = arg.getProperties().some(p =>
          Node.isPropertyAssignment(p) && p.getName() === 'standalone'
        );

        if (!hasStandalone) {
          // Insert standalone: false as the first property
          arg.insertPropertyAssignment(0, {
            name: 'standalone',
            initializer: 'false',
          });
          fileChanged = true;
          changes.push({
            file: sf.getFilePath(),
            description: `@${dec.getName()}(${cls.getName() ?? ''}): added standalone: false (Angular 19 default changed to true)`,
          });
        }
      });
    });

    if (fileChanged && !ctx.dryRun) {
      sf.saveSync();
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// zone.js import path fixes (v16 → v17)
// ---------------------------------------------------------------------------

/**
 * Fix zone.js deep imports to shallow imports.
 *
 * Before:
 *   import 'zone.js/dist/zone';
 *   import 'zone.js/dist/zone-testing';
 *   import 'zone.js/bundles/zone-testing.js';
 *
 * After:
 *   import 'zone.js';
 *   import 'zone.js/testing';
 */
export function fixZoneJsImports(
  projectPath: string,
  ctx: MigrationContext
): Change[] {
  const changes: Change[] = [];

  // Typical files that contain zone.js imports
  const candidates = globSync('**/{polyfills,test,setup-jest,jest-setup,test-setup}.ts', {
    cwd: projectPath,
    ignore: ['node_modules/**', 'dist/**'],
    absolute: true,
  });

  const replacements: Array<[RegExp, string]> = [
    [/(['"])zone\.js\/dist\/zone\1/g, "$1zone.js$1"],
    [/(['"])zone\.js\/dist\/zone-testing\1/g, "$1zone.js/testing$1"],
    [/(['"])zone\.js\/bundles\/zone-testing\.js\1/g, "$1zone.js/testing$1"],
    [/(['"])zone\.js\/dist\/long-stack-trace-zone\1/g, "$1zone.js/plugins/long-stack-trace-zone$1"],
    [/(['"])zone\.js\/dist\/async-test\1/g, "$1zone.js/testing$1"],
    [/(['"])zone\.js\/dist\/fake-async-test\1/g, "$1zone.js/testing$1"],
  ];

  for (const filePath of candidates) {
    let content = fs.readFileSync(filePath, 'utf-8');
    let changed = false;

    for (const [pattern, replacement] of replacements) {
      const newContent = content.replace(pattern, replacement);
      if (newContent !== content) {
        content = newContent;
        changed = true;
      }
    }

    if (changed) {
      if (!ctx.dryRun) {
        fs.writeFileSync(filePath, content, 'utf-8');
      }
      changes.push({
        file: filePath,
        description: 'Fixed zone.js deep imports → shallow imports',
      });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// async() → waitForAsync() (v17 → v18)
// ---------------------------------------------------------------------------

/**
 * Rename the deprecated `async` testing helper to `waitForAsync`.
 *
 * Before: import { async } from '@angular/core/testing';
 * After:  import { waitForAsync } from '@angular/core/testing';
 *         (and renames all call sites)
 */
export function migrateAsyncToWaitForAsync(
  sourceFiles: SourceFile[],
  ctx: MigrationContext
): Change[] {
  return renameNamedImport(
    sourceFiles,
    '@angular/core/testing',
    'async',
    'waitForAsync',
    ctx
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getSourceFiles(project: Project, projectPath: string): SourceFile[] {
  return project.getSourceFiles().filter(sf => {
    const fp = sf.getFilePath();
    return !fp.includes('node_modules') && !fp.includes('/dist/');
  });
}
