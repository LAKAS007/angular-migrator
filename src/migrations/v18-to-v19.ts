import { MigrationStep, MigrationContext, MigrationResult } from '../types';
import { updatePackageVersions } from '../utils/pkg';
import {
  createTsProject,
  getSourceFiles,
  renameNamedImport,
  removeObsoleteImport,
  removeBrowserModuleWithServerTransition,
  addStandaloneFalse,
} from '../utils/codemods';
import { SyntaxKind, Node } from 'ts-morph';

/**
 * Angular 18 → 19
 *
 * Breaking changes (official migration guide):
 *
 * RENAMES:
 * - ExperimentalPendingTasks → PendingTasks (@angular/core)
 *
 * REMOVED APIs:
 * - BrowserModule.withServerTransition() (@angular/platform-browser) — use APP_ID token
 * - Router.errorHandler property → withNavigationErrorHandler() provider function
 * - KeyValueDiffers.factories property — use KeyValueDiffer directly
 *
 * BEHAVIOR CHANGES requiring code action:
 * - standalone defaults to true for @Component/@Directive/@Pipe
 *   → Add standalone: false to all existing NgModule-based declarations
 *
 * BEHAVIOR CHANGES (warnings):
 * - Effects now run during change detection, not as microtasks
 * - ComponentFixture.autoDetect now attaches to ApplicationRef (errors go to ErrorHandler)
 * - ApplicationRef.tick errors in TestBed are rethrown (use expect().toThrow() or rethrowApplicationErrors: false)
 * - routerLink: null/undefined now removes href attribute
 * - TestBed zone coalescing runs above Angular zone (affects fakeAsync timer tests)
 * - Template property reads: this.foo no longer refers to template variables, use without this
 * - createComponent projectable: undefined fallback changed to empty array
 */
export const v18ToV19: MigrationStep = {
  from: 18,
  to: 19,
  name: 'Angular 18 → 19',

  async run(ctx: MigrationContext): Promise<MigrationResult> {
    const result: MigrationResult = {
      step: this.name,
      changes: [],
      warnings: [],
      errors: [],
    };

    ctx.logger.step('Angular 18 → 19');

    // 1. package.json
    ctx.logger.info('Updating package versions...');
    const pkgChanges = updatePackageVersions(ctx, {
      '@angular/animations':              '^19.2.0',
      '@angular/cdk':                      '^19.2.0',
      '@angular/cli':                      '^19.2.0',
      '@angular/common':                   '^19.2.0',
      '@angular/compiler':                 '^19.2.0',
      '@angular/compiler-cli':             '^19.2.0',
      '@angular/core':                     '^19.2.0',
      '@angular/elements':                 '^19.2.0',
      '@angular/forms':                    '^19.2.0',
      '@angular/language-service':         '^19.2.0',
      '@angular/material':                 '^19.2.0',
      '@angular/platform-browser':         '^19.2.0',
      '@angular/platform-browser-dynamic': '^19.2.0',
      '@angular/platform-server':          '^19.2.0',
      '@angular/router':                   '^19.2.0',
      '@angular/service-worker':           '^19.2.0',
      '@angular-devkit/build-angular':     '^19.2.0',
      '@angular-devkit/core':              '^19.2.0',
      '@angular-devkit/schematics':        '^19.2.0',
      'typescript':                        '~5.6.0',
    });
    pkgChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...pkgChanges);

    // 2. TypeScript codemods
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

    // ExperimentalPendingTasks → PendingTasks
    ctx.logger.info('Migrating ExperimentalPendingTasks → PendingTasks...');
    const pendingTasksChanges = renameNamedImport(
      sourceFiles, '@angular/core', 'ExperimentalPendingTasks', 'PendingTasks', ctx
    );
    pendingTasksChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...pendingTasksChanges);

    // BrowserModule.withServerTransition() → BrowserModule (removed in v19)
    ctx.logger.info('Removing BrowserModule.withServerTransition()...');
    const serverTransitionChanges = removeBrowserModuleWithServerTransition(sourceFiles, ctx);
    serverTransitionChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...serverTransitionChanges);
    if (serverTransitionChanges.length > 0) {
      result.warnings.push({
        file: 'angular.json',
        message: `BrowserModule.withServerTransition() removed. Replaced with BrowserModule. If you need a stable app ID for SSR, add: { provide: APP_ID, useValue: 'my-app' } to providers.`,
      });
    }

    // KeyValueDiffers.factories — removed
    const { changes: kvdChanges, warnings: kvdWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/core', 'KeyValueDiffers', ctx
    );
    // Only warn if .factories is actually accessed
    for (const sf of sourceFiles) {
      sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach(pa => {
        if (pa.getName() === 'factories') {
          const objText = pa.getExpression().getText();
          if (objText.toLowerCase().includes('differ')) {
            result.warnings.push({
              file: sf.getFilePath(),
              message: `KeyValueDiffers.factories removed in Angular 19. Use KeyValueDiffer directly via DI.`,
            });
          }
        }
      });
    }

    // Router.errorHandler property — removed
    for (const sf of sourceFiles) {
      sf.getDescendantsOfKind(SyntaxKind.BinaryExpression).forEach(bin => {
        const left = bin.getLeft();
        if (!Node.isPropertyAccessExpression(left)) return;
        if (left.getName() !== 'errorHandler') return;
        const objType = left.getExpression().getText();
        if (objType.toLowerCase().includes('router')) {
          result.warnings.push({
            file: sf.getFilePath(),
            message: `router.errorHandler = ... removed in Angular 19. Use withNavigationErrorHandler((e) => ...) in provideRouter() or RouterModule.forRoot(routes, { errorHandler: ... }) instead.`,
          });
          ctx.logger.warn(`${sf.getBaseName()}: router.errorHandler assignment — use withNavigationErrorHandler()`);
        }
      });
    }

    // standalone: false — add to all components/directives/pipes that don't have it
    // (Angular 19 changed the default from false to true)
    ctx.logger.info('Adding standalone: false to NgModule-based declarations...');
    const standaloneChanges = addStandaloneFalse(sourceFiles, ctx);
    standaloneChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...standaloneChanges);
    if (standaloneChanges.length > 0) {
      result.warnings.push({
        file: 'angular.json',
        message: `[Angular 19] Added standalone: false to ${standaloneChanges.length} component(s)/directive(s)/pipe(s). Angular 19 changed the default to standalone: true. Components with standalone: true that are still in NgModule.declarations should be removed from declarations[].`,
      });
    }

    // Detect legacy Angular Material components (removed in v19)
    const legacyMaterialModules = [
      'MatLegacyButtonModule', 'MatLegacyCardModule', 'MatLegacyCheckboxModule',
      'MatLegacyChipsModule', 'MatLegacyDialogModule', 'MatLegacyFormFieldModule',
      'MatLegacyInputModule', 'MatLegacyListModule', 'MatLegacyMenuModule',
      'MatLegacyProgressBarModule', 'MatLegacyProgressSpinnerModule', 'MatLegacyRadioModule',
      'MatLegacySelectModule', 'MatLegacySlideToggleModule', 'MatLegacySliderModule',
      'MatLegacySnackBarModule', 'MatLegacyTableModule', 'MatLegacyTabsModule',
      'MatLegacyTooltipModule',
    ];
    for (const sf of sourceFiles) {
      for (const imp of sf.getImportDeclarations()) {
        if (!imp.getModuleSpecifierValue().startsWith('@angular/material')) continue;
        const found = imp.getNamedImports()
          .filter(ni => legacyMaterialModules.includes(ni.getName()))
          .map(ni => ni.getName());
        if (found.length > 0) {
          result.warnings.push({
            file: sf.getFilePath(),
            message: `Legacy Angular Material components removed in v19: ${found.join(', ')}. Replace with MDC-based equivalents (remove 'Legacy' from the class name).`,
          });
          ctx.logger.warn(`${sf.getBaseName()}: legacy Material: ${found.join(', ')}`);
        }
      }
    }

    // Behavior change warnings
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 19] Signal effects now run during change detection (not as microtasks). Effects outside change detection will now run during the next CD cycle.',
    });
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 19] [routerLink]="null" now removes the href attribute. Review conditional routerLink bindings that use null/undefined as a "disabled" state.',
    });
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 19] Template property reads: this.foo in templates no longer refers to template variables. If you have template variables and class properties with the same name, remove this. prefix.',
    });
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 19] ApplicationRef.tick() errors in TestBed are now rethrown. Wrap expected-to-throw scenarios with expect(() => fixture.detectChanges()).toThrow(), or set rethrowApplicationErrors: false in TestBed.',
    });

    return result;
  },
};
