// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as glob from 'glob';
import globEscape = require('glob-escape');
import * as os from 'os';
import * as path from 'path';
import * as fsx from 'fs-extra';
import { CommandLineAction, CommandLineFlagParameter } from '@microsoft/ts-command-line';
import {
  AsyncRecycle,
  IPackageJson,
  JsonFile,
  RushConfiguration,
  RushConfigurationProject,
  Utilities,
  Stopwatch
} from '@microsoft/rush-lib';

import InstallAction from './InstallAction';
import RushCommandLineParser from './RushCommandLineParser';
import PackageReviewChecker from '../utilities/PackageReviewChecker';
import { TempModuleGenerator } from '../utilities/TempModuleGenerator';

export default class GenerateAction extends CommandLineAction {
  private _parser: RushCommandLineParser;
  private _rushConfiguration: RushConfiguration;
  private _packageReviewChecker: PackageReviewChecker;
  private _lazyParameter: CommandLineFlagParameter;

  private static _deleteCommonNodeModules(rushConfiguration: RushConfiguration, isLazy: boolean): void {
    const nodeModulesPath: string = path.join(rushConfiguration.commonFolder, 'node_modules');

    if (isLazy) {
      // In the lazy case, we keep the existing common/node_modules.  However, we need to delete
      // the temp projects (that were copied from common/temp_modules into common/node_modules).
      // We can recognize them because their names start with "rush-"
      console.log('Deleting common/node_modules/rush-*');
      const normalizedPath: string = Utilities.getAllReplaced(nodeModulesPath, '\\', '/');
      for (const tempModulePath of glob.sync(globEscape(normalizedPath) + '/rush-*')) {
        AsyncRecycle.recycleDirectory(rushConfiguration, tempModulePath);
      }
    } else {
      if (fsx.existsSync(nodeModulesPath)) {
        console.log('Deleting common/node_modules folder...');
        AsyncRecycle.recycleDirectory(rushConfiguration, nodeModulesPath);
      }
    }
  }

  private static _deleteCommonTempModules(rushConfiguration: RushConfiguration): void {
    if (fsx.existsSync(rushConfiguration.tempModulesFolder)) {
      console.log('Deleting common/temp_modules folder');
      Utilities.dangerouslyDeletePath(rushConfiguration.tempModulesFolder);
    }
  }

  private static _deleteShrinkwrapFile(rushConfiguration: RushConfiguration): void {
    const shrinkwrapFilename: string = path.join(rushConfiguration.commonFolder, 'npm-shrinkwrap.json');

    if (fsx.existsSync(shrinkwrapFilename)) {
      console.log('Deleting common/npm-shrinkwrap.json');
      Utilities.dangerouslyDeletePath(shrinkwrapFilename);
    }
  }

  private static _createCommonTempModulesAndPackageJson(rushConfiguration: RushConfiguration): void {
    console.log('Creating a clean common/temp_modules folder');
    Utilities.createFolderWithRetry(rushConfiguration.tempModulesFolder);

    const commonPackageJson: PackageJson = {
      dependencies: {},
      description: 'Temporary file generated by the Rush tool',
      name: 'rush-common',
      private: true,
      version: '0.0.0'
    };

    // Add any pinned versions to the top of the commonPackageJson
    rushConfiguration.pinnedVersions.forEach((version: string, dependency: string) => {
      commonPackageJson.dependencies[dependency] = version;
    });

    console.log('Creating temp projects...');

    // To make the common/package.json file more readable, sort alphabetically
    // according to rushProject.tempProjectName instead of packageName.
    const sortedRushProjects: RushConfigurationProject[] = rushConfiguration.projects.slice(0);
    sortedRushProjects.sort(
      (a: RushConfigurationProject, b: RushConfigurationProject) => a.tempProjectName.localeCompare(b.tempProjectName)
    );

    const tempModules: Map<string, IPackageJson> = new TempModuleGenerator(rushConfiguration).tempModules;

    for (const rushProject of sortedRushProjects) {
      const packageJson: PackageJson = rushProject.packageJson;

      const tempProjectName: string = rushProject.tempProjectName;

      const tempProjectFolder: string = path.join(rushConfiguration.tempModulesFolder, tempProjectName);
      fsx.mkdirSync(tempProjectFolder);

      commonPackageJson.dependencies[tempProjectName] = 'file:./temp_modules/' + tempProjectName;

      const tempPackageJsonFilename: string = path.join(tempProjectFolder, 'package.json');

      JsonFile.saveJsonFile(tempModules.get(rushProject.packageName), tempPackageJsonFilename);
    }

    console.log('Writing common/package.json');
    const commonPackageJsonFilename: string = path.join(rushConfiguration.commonFolder, 'package.json');
    JsonFile.saveJsonFile(commonPackageJson, commonPackageJsonFilename);
  }

  private static _runNpmInstall(rushConfiguration: RushConfiguration): void {
    const npmInstallArgs: string[] = ['install'];
    if (rushConfiguration.cacheFolder) {
      npmInstallArgs.push('--cache', rushConfiguration.cacheFolder);
    }

    if (rushConfiguration.tmpFolder) {
      npmInstallArgs.push('--tmp', rushConfiguration.tmpFolder);
    }

    console.log(os.EOL + colors.bold(`Running "npm ${npmInstallArgs.join(' ')}"...`));
    Utilities.executeCommand(rushConfiguration.npmToolFilename,
                             npmInstallArgs,
                             rushConfiguration.commonFolder);
    console.log('"npm install" completed' + os.EOL);
  }

  private static _runNpmShrinkWrap(rushConfiguration: RushConfiguration, isLazy: boolean): void {
    if (isLazy) {
      // If we're not doing it for real, then don't bother with "npm shrinkwrap"
      console.log(os.EOL + colors.bold('(Skipping "npm shrinkwrap")') + os.EOL);
    } else {
      console.log(os.EOL + colors.bold('Running "npm shrinkwrap"...'));
      Utilities.executeCommand(rushConfiguration.npmToolFilename,
                               ['shrinkwrap' ],
                               rushConfiguration.commonFolder);
      console.log('"npm shrinkwrap" completed' + os.EOL);
    }
  }

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'generate',
      summary: 'Run this command after changing any project\'s package.json.',
      documentation: 'Run "rush regenerate" after changing any project\'s package.json.'
      + ' It scans the dependencies for all projects referenced in "rush.json", and then'
      + ' constructs a superset package.json in the Rush common folder.'
      + ' After running this command, you will need to commit your changes to git.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._lazyParameter = this.defineFlagParameter({
      parameterLongName: '--lazy',
      parameterShortName: '-l',
      description: 'Do not clean the "node_modules" folder before running "npm install".'
        + ' This is faster, but less correct, so only use it for debugging.'
    });
  }

  protected onExecute(): void {
    this._rushConfiguration = RushConfiguration.loadFromDefaultLocation();

    const stopwatch: Stopwatch = Stopwatch.start();

    console.log('Starting "rush generate"' + os.EOL);

    if (this._rushConfiguration.packageReviewFile) {
        this._packageReviewChecker = new PackageReviewChecker(this._rushConfiguration);
        this._packageReviewChecker.saveCurrentDependencies();
    }

    // 1. Delete "common\node_modules"
    GenerateAction._deleteCommonNodeModules(this._rushConfiguration, this._lazyParameter.value);

    // 2. Delete the previous npm-shrinkwrap.json
    GenerateAction._deleteShrinkwrapFile(this._rushConfiguration);

    // 3. Delete "common\temp_modules"
    GenerateAction._deleteCommonTempModules(this._rushConfiguration);

    // 4. Construct common\package.json and common\temp_modules
    GenerateAction._createCommonTempModulesAndPackageJson(this._rushConfiguration);

    // 5. Make sure the NPM tool is set up properly.  Usually "rush install" should have
    //    already done this, but not if they just cloned the repo
    console.log('');
    InstallAction.ensureLocalNpmTool(this._rushConfiguration, false);

    // 6. Run "npm install" and "npm shrinkwrap"
    GenerateAction._runNpmInstall(this._rushConfiguration);
    GenerateAction._runNpmShrinkWrap(this._rushConfiguration, this._lazyParameter.value);

    stopwatch.stop();
    console.log(os.EOL + colors.green(`Rush generate finished successfully. (${stopwatch.toString()})`));
    console.log(os.EOL + 'Next you should probably run: "rush link"');
  }
}
