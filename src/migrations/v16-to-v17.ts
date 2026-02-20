import { MigrationStep, MigrationContext, MigrationResult } from '../types';
import { updatePackageVersions, replacePackageDependency } from '../utils/pkg';
import { migrateBrowserBuilderToApplication, removeDefaultProject } from '../utils/angular-json';
import {
  createTsProject,
  getSourceFiles,
  renameNamedImport,
  moveImport,
  removeObsoleteImport,
  migrateComponentFactoryResolver,
  migrateCanLoadToCanMatch,
  fixZoneJsImports,
  removeDominoSetup,
} from '../utils/codemods';
import { SyntaxKind, Node } from 'ts-morph';

/**
 * Angular 16 → 17
 *
 * Breaking changes (official migration guide):
 *
 * IMPORT MOVES / RENAMES:
 * - RouterLinkWithHref: REMOVED, merged into RouterLink
 * - zone.js deep imports → shallow imports (dist/ → top-level)
 *
 * REMOVED APIs:
 * - ComponentFactory / ComponentFactoryResolver (@angular/core) — use type directly
 * - CanLoad (@angular/router) → CanMatch
 * - ANALYZE_FOR_ENTRY_COMPONENTS (@angular/core) — already done in v15→v16
 * - setupTestingRouter() — use RouterModule.forRoot() or provideRouter()
 * - withNoDomReuse() — use ngSkipHydration attribute
 * - Router direct property assignments (urlHandlingStrategy, canceledNavigationResolution,
 *   paramsInheritanceStrategy, titleStrategy, urlUpdateStrategy, malformedUriErrorHandler)
 *   → configure via provideRouter() options
 *
 * BEHAVIOR CHANGES (warnings):
 * - WritableSignal.mutate() removed → use update() with immutable pattern
 * - REMOVE_STYLES_ON_COMPONENT_DESTROY now defaults to true
 * - OnPush dynamically created components: only refreshes when marked dirty
 * - NgSwitch equality changed from == to ===
 * - Router: absolute redirects are now non-terminal (may cause redirect loops)
 * - Node.js: 18.13.0+ required
 */
export const v16ToV17: MigrationStep = {
  from: 16,
  to: 17,
  name: 'Angular 16 → 17',

  async run(ctx: MigrationContext): Promise<MigrationResult> {
    const result: MigrationResult = {
      step: this.name,
      changes: [],
      warnings: [],
      errors: [],
    };

    ctx.logger.step('Angular 16 → 17');

    // 1. package.json
    ctx.logger.info('Updating package versions...');
    const pkgChanges = updatePackageVersions(ctx, {
      '@angular/animations':              '^17.3.0',
      '@angular/cdk':                      '^17.3.0',
      '@angular/cli':                      '^17.3.0',
      '@angular/common':                   '^17.3.0',
      '@angular/compiler':                 '^17.3.0',
      '@angular/compiler-cli':             '^17.3.0',
      '@angular/core':                     '^17.3.0',
      '@angular/elements':                 '^17.3.0',
      '@angular/forms':                    '^17.3.0',
      '@angular/language-service':         '^17.3.0',
      '@angular/material':                 '^17.3.0',
      '@angular/platform-browser':         '^17.3.0',
      '@angular/platform-browser-dynamic': '^17.3.0',
      '@angular/platform-server':          '^17.3.0',
      '@angular/router':                   '^17.3.0',
      '@angular/service-worker':           '^17.3.0',
      '@angular-devkit/build-angular':     '^17.3.0',
      '@angular-devkit/core':              '^17.3.0',
      '@angular-devkit/schematics':        '^17.3.0',
      'typescript':                        '~5.2.0',
      'zone.js':                           '~0.14.0',
    });
    pkgChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...pkgChanges);

    // 2. angular.json: browser → application builder
    ctx.logger.info('Migrating angular.json builder...');
    const builderChanges = migrateBrowserBuilderToApplication(ctx);
    builderChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...builderChanges);

    const defaultProjectChanges = removeDefaultProject(ctx);
    defaultProjectChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...defaultProjectChanges);

    // 3. zone.js import path fixes
    ctx.logger.info('Fixing zone.js import paths...');
    const zoneChanges = fixZoneJsImports(ctx.projectPath, ctx);
    zoneChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...zoneChanges);

    // 3a. @nguniversal/express-engine → @angular/ssr (package.json)
    ctx.logger.info('Replacing @nguniversal/express-engine with @angular/ssr...');
    const ssrPkgChanges = replacePackageDependency(
      ctx,
      '@nguniversal/express-engine',
      '@angular/ssr',
      '^17.3.0'
    );
    ssrPkgChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...ssrPkgChanges);

    // 4. TypeScript codemods
    ctx.logger.info('Scanning TypeScript files...');
    let project;
    try {
      project = createTsProject(ctx.projectPath);
    } catch (e) {
      result.warnings.push({ file: 'tsconfig.json', message: `Could not load TypeScript project: ${e}` });
      return result;
    }

    const sourceFiles = getSourceFiles(project, ctx.projectPath);
    ctx.logger.info(`Found ${sourceFiles.length} TypeScript files`);

    // RouterLinkWithHref → RouterLink
    ctx.logger.info('Migrating RouterLinkWithHref → RouterLink...');
    const routerLinkChanges = renameNamedImport(
      sourceFiles, '@angular/router', 'RouterLinkWithHref', 'RouterLink', ctx
    );
    routerLinkChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...routerLinkChanges);

    // @nguniversal/express-engine → @angular/ssr (TypeScript imports)
    ctx.logger.info('Migrating @nguniversal/express-engine imports → @angular/ssr...');
    const ngExpressChanges = moveImport(
      sourceFiles, 'ngExpressEngine', '@nguniversal/express-engine', '@angular/ssr', ctx
    );
    ngExpressChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...ngExpressChanges);

    // CommonEngine lives in @angular/ssr/node (Node.js-specific subpath)
    const commonEngineChanges = moveImport(
      sourceFiles, 'CommonEngine', '@nguniversal/express-engine', '@angular/ssr/node', ctx
    );
    commonEngineChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...commonEngineChanges);

    // Remove domino SSR polyfill
    ctx.logger.info('Removing domino SSR polyfill...');
    const dominoChanges = removeDominoSetup(sourceFiles, ctx);
    dominoChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...dominoChanges);

    // CanLoad → CanMatch
    ctx.logger.info('Migrating CanLoad → CanMatch...');
    const canLoadChanges = migrateCanLoadToCanMatch(sourceFiles, ctx);
    canLoadChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...canLoadChanges);

    // ComponentFactory / ComponentFactoryResolver removal
    ctx.logger.info('Migrating ComponentFactoryResolver...');
    const { changes: cfrChanges, warnings: cfrWarnings } = migrateComponentFactoryResolver(sourceFiles, ctx);
    cfrChanges.forEach(c => ctx.logger.change(c.file, c.description));
    cfrWarnings.forEach(w => ctx.logger.warn(w.message));
    result.changes.push(...cfrChanges);
    result.warnings.push(...cfrWarnings);

    // Remove remaining ComponentFactory / ComponentFactoryResolver imports
    for (const sym of ['ComponentFactory', 'ComponentFactoryResolver'] as const) {
      const { changes } = removeObsoleteImport(sourceFiles, '@angular/core', sym, ctx);
      changes.forEach(c => ctx.logger.change(c.file, c.description));
      result.changes.push(...changes);
    }

    // setupTestingRouter() — removed
    const { changes: strChanges, warnings: strWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/router/testing', 'setupTestingRouter', ctx
    );
    strChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...strChanges);
    result.warnings.push(...strWarnings.map(w => ({
      ...w,
      message: `setupTestingRouter() removed. Use RouterModule.forRoot([]) or provideRouter([]) in TestBed.configureTestingModule instead.`,
    })));

    // withNoDomReuse() — removed
    const { changes: noDomChanges, warnings: noDomWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/platform-browser', 'withNoDomReuse', ctx
    );
    noDomChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...noDomChanges);
    result.warnings.push(...noDomWarnings.map(w => ({
      ...w,
      message: `withNoDomReuse() removed. Use the ngSkipHydration attribute on the <app-root> tag instead.`,
    })));

    // Detect WritableSignal.mutate() usage
    ctx.logger.info('Checking for signal.mutate() usage...');
    for (const sf of sourceFiles) {
      sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(call => {
        const expr = call.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) return;
        if (expr.getName() === 'mutate') {
          result.warnings.push({
            file: sf.getFilePath(),
            message: `signal.mutate() removed in Angular 17. Replace with signal.update(val => { ...val, changedProp }). Found: ${call.getText().slice(0, 80)}`,
          });
          ctx.logger.warn(`${sf.getBaseName()}: .mutate() call found — replace with .update()`);
        }
      });
    }

    // Detect direct Router property assignments (now must go through provideRouter)
    const movedRouterProps = [
      'urlHandlingStrategy',
      'canceledNavigationResolution',
      'paramsInheritanceStrategy',
      'titleStrategy',
      'urlUpdateStrategy',
      'malformedUriErrorHandler',
    ];
    for (const sf of sourceFiles) {
      sf.getDescendantsOfKind(SyntaxKind.BinaryExpression).forEach(bin => {
        const left = bin.getLeft();
        if (!Node.isPropertyAccessExpression(left)) return;
        if (movedRouterProps.includes(left.getName())) {
          result.warnings.push({
            file: sf.getFilePath(),
            message: `router.${left.getName()} = ... is no longer supported in Angular 17. Configure via provideRouter([routes], with${left.getName().charAt(0).toUpperCase() + left.getName().slice(1)}(...)) or RouterModule.forRoot config.`,
          });
        }
      });
    }

    // entryComponents warning (if missed in v15→v16)
    for (const sf of sourceFiles) {
      sf.getClasses().forEach(cls => {
        cls.getDecorators().forEach(dec => {
          if (dec.getName() !== 'NgModule') return;
          const args = dec.getArguments();
          if (args.length > 0 && args[0].getText().includes('entryComponents')) {
            result.warnings.push({
              file: sf.getFilePath(),
              message: `${cls.getName()}: entryComponents must be removed before Angular 17.`,
            });
          }
        });
      });
    }

    // Behavior change warnings
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 17] REMOVE_STYLES_ON_COMPONENT_DESTROY now defaults to true. Component styles are removed on destroy. If your app relies on styles persisting, add { provide: REMOVE_STYLES_ON_COMPONENT_DESTROY, useValue: false } to providers.',
    });
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 17] NgSwitch now uses strict equality (===) instead of loose equality (==). Review switch cases that relied on type coercion.',
    });
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 17] Router absolute redirects are now non-terminal (processing continues after redirect). Check route configs for potential infinite redirect loops.',
    });

    return result;
  },
};
