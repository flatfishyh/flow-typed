// @flow

import semver from "semver";

import {cloneInto, findLatestFileCommitHash, rebaseRepoMaster} from "./git.js";
import {mkdirp} from "./fileUtils.js";
import {fs, path, os} from "./node.js";
import {
  emptyVersion,
  versionToString,
} from "./semver.js";
import type {Version} from "./semver.js";
import {
  disjointVersionsAll,
  parseDirString as parseFlowDirString,
  toSemverString as flowVerToSemver,
  toDirString as flowVerToDirString,
} from "./flowVersion.js";
import type {FlowVersion} from "./flowVersion.js";
import type {ValidationErrors as VErrors} from "./validationErrors";
import {validationError} from "./validationErrors";

const P = Promise;

export type LibDef = {|
  pkgName: string,
  pkgVersionStr: string,
  flowVersion: FlowVersion,
  flowVersionStr: string,
  path: string,
  testFilePaths: Array<string>,
|};

const CACHE_DIR = path.join(os.homedir(), '.flow-typed');
const CACHE_REPO_DIR = path.join(CACHE_DIR, 'repo');
const GIT_REPO_DIR = path.join(__dirname, '..', '..', '..');

const REMOTE_REPO_URL = 'http://github.com/flowtype/flow-typed.git';
const LAST_UPDATED_FILE = path.join(CACHE_DIR, 'lastUpdated');

async function cloneCacheRepo(verbose?: VerboseOutput) {
  await mkdirp(CACHE_REPO_DIR);
  try {
    await cloneInto(REMOTE_REPO_URL, CACHE_REPO_DIR);
  } catch (e) {
    writeVerbose(verbose, 'ERROR: Unable to clone the local cache repo.');
    throw e;
  }
  await fs.writeFile(LAST_UPDATED_FILE, String(Date.now()));
}

const CACHE_REPO_GIT_DIR = path.join(CACHE_REPO_DIR, '.git');
async function rebaseCacheRepo(verbose?: VerboseOutput) {
  if (await fs.exists(CACHE_REPO_DIR) && await fs.exists(CACHE_REPO_GIT_DIR)) {
    try {
      await rebaseRepoMaster(CACHE_REPO_DIR);
    } catch (e) {
      writeVerbose(
        verbose,
        'ERROR: Unable to rebase the local cache repo. ' + e.message
      );
      return false;
    }
    await fs.writeFile(LAST_UPDATED_FILE, String(Date.now()));
    return true;
  } else {
    await cloneCacheRepo(verbose);
    return true;
  }
}

/**
 * Utility wrapper for ensureCacheRepo with an update expiry of 0 hours.
 */
async function updateCacheRepo(verbose?: VerboseOutput) {
  return await ensureCacheRepo(verbose, 0);
}

/**
 * Ensure that the CACHE_REPO_DIR exists and is recently rebased.
 * (else: create/rebase it)
 */
const CACHE_REPO_EXPIRY = 1000 * 60; // 1 minute
export const _cacheRepoAssure = {
  lastAssured: 0,
  pendingAssure: Promise.resolve(),
};
async function ensureCacheRepo(
  verbose?: VerboseOutput,
  cacheRepoExpiry: number = CACHE_REPO_EXPIRY
) {
  // Only re-run rebase checks if a check hasn't been run in the last 5 minutes
  if (_cacheRepoAssure.lastAssured + (5 * 1000 * 60) >= Date.now()) {
    return _cacheRepoAssure.pendingAssure;
  }

  _cacheRepoAssure.lastAssured = Date.now();
  const prevAssure = _cacheRepoAssure.pendingAssure;
  return _cacheRepoAssure.pendingAssure =
    prevAssure.then(() => (async function() {
      const repoDirExists = fs.exists(CACHE_REPO_DIR);
      const repoGitDirExists = fs.exists(CACHE_REPO_GIT_DIR);
      if (!await repoDirExists || !await repoGitDirExists) {
        writeVerbose(
          verbose,
          '• flow-typed cache not found, fetching from GitHub...',
          false
        );
        await cloneCacheRepo(verbose);
        writeVerbose(verbose, 'done.');
      } else {
        let lastUpdated = 0;
        if (await fs.exists(LAST_UPDATED_FILE)) {
          // If the LAST_UPDATED_FILE has anything other than just a number in
          // it, just assume we need to update.
          const lastUpdatedRaw = await fs.readFile(LAST_UPDATED_FILE);
          const lastUpdatedNum = parseInt(lastUpdatedRaw, 10);
          if (String(lastUpdatedNum) === String(lastUpdatedRaw)) {
            lastUpdated = lastUpdatedNum;
          }
        }

        if ((lastUpdated + cacheRepoExpiry) < Date.now()) {
          writeVerbose(verbose, '• rebasing flow-typed cache...', false);
          const rebaseSuccessful = await rebaseCacheRepo(verbose);
          if (rebaseSuccessful) {
            writeVerbose(verbose, 'done.');
          } else {
            writeVerbose(
              verbose,
              '\nNOTE: Unable to rebase local cache! If you don\'t currently ' +
              'have internet connectivity, no worries -- we\'ll update the ' +
              'local cache the next time you do.\n'
            );
          }
        }
      }
    })());
}
// Exported for tests -- since we really want this part well-tested.
export {
  CACHE_REPO_DIR as _CACHE_REPO_DIR,
  CACHE_REPO_EXPIRY as _CACHE_REPO_EXPIRY,
  CACHE_REPO_GIT_DIR as _CACHE_REPO_GIT_DIR,
  ensureCacheRepo as _ensureCacheRepo,
  updateCacheRepo,
  LAST_UPDATED_FILE as _LAST_UPDATED_FILE,
  REMOTE_REPO_URL as _REMOTE_REPO_URL,
};

async function addLibDefs(pkgDirPath, libDefs: Array<LibDef>, validationErrs?: VErrors) {
  const parsedDirItem = parseRepoDirItem(pkgDirPath, validationErrs);
  (await parseLibDefsFromPkgDir(
    parsedDirItem,
    pkgDirPath,
    validationErrs
  )).forEach(libDef => libDefs.push(libDef));
}

/**
 * Given a 'definitions/npm' dir, return a list of LibDefs that it contains.
 */
export async function getLibDefs(
  defsDir: string,
  validationErrs?: VErrors,
) {
  const libDefs: Array<LibDef> = [];
  const defsDirItems = await fs.readdir(defsDir);
  await P.all(defsDirItems.map(async (item) => {
    if (item === '.cli-metadata.json') {
      return;
    }
    const itemPath = path.join(defsDir, item);
    const itemStat = await fs.stat(itemPath);
    if (itemStat.isDirectory()) {
      if (item.charAt(0) === '@') {
        // directory is of the form '@<scope>', so go one level deeper
        const scope = item;
        const defsDirItems = await fs.readdir(itemPath);
        await P.all(defsDirItems.map(async (item) => {
          const itemPath = path.join(defsDir, scope, item);
          const itemStat = await fs.stat(itemPath);
          if (itemStat.isDirectory()) {
            // itemPath is a lib dir
            await addLibDefs(itemPath, libDefs, validationErrs);
          } else {
            const error =
              `Expected only directories in the 'definitions/npm/@<scope>' directory!`;
            validationError(itemPath, error, validationErrs);
          }
        }));
      } else {
        // itemPath is a lib dir
        await addLibDefs(itemPath, libDefs, validationErrs);
      }
    } else {
      const error =
        `Expected only directories in the 'definitions/npm' directory!`;
      validationError(itemPath, error, validationErrs);
    }
  }));
  return libDefs;
};

export function _flowVersionToVersion(flow: FlowVersion): Version {
  const result = (() => {switch (flow.kind) {
    case 'all': return {
      range: undefined,
      major: 'x',
      minor: 'x',
      patch: 'x',
      upperBound: undefined,
    };
    case 'specific': return {
      range: undefined,
      major: flow.ver.major,
      minor: flow.ver.minor,
      patch: flow.ver.patch,
      upperBound: undefined,
    };
    case 'ranged':
      const {upper, lower} = flow;
      const [lowerBound, upperBound, range] = (() => {
        if (lower != null && upper != null) {
          return [
            _flowVersionToVersion({kind: 'specific', ver: lower}),
            _flowVersionToVersion({kind: 'specific', ver: upper}),
            '>=',
          ];
        } else if (lower != null) {
          return [
            _flowVersionToVersion({kind: 'specific', ver: lower}),
            undefined,
            '>='
          ];
        } else if (upper != null) {
          return [
            _flowVersionToVersion({kind: 'specific', ver: upper}),
            undefined,
            '<='
          ];
        } else {
          (lower: null);
          (upper: null);
          throw new Error('wat');
        }
      })();
      if (upperBound) {
        upperBound.range = "<=";
      }
      lowerBound.upperBound = upperBound;
      lowerBound.range = range;
      return lowerBound;
    default: (flow: empty); throw new Error('Unexpected FlowVersion kind!');
  }})();
  return result;
}

function parsePkgFlowDirVersion(pkgFlowDirPath, validationErrs): FlowVersion {
  const pkgFlowDirName = path.basename(pkgFlowDirPath);
  return parseFlowDirString(pkgFlowDirName, validationErrs);
}

/**
 * Given a parsed package name and version and a path to the package directory
 * on disk, scan the directory and generate a list of LibDefs for each
 * flow-versioned definition file.
 */
async function parseLibDefsFromPkgDir(
  {pkgName, pkgVersion},
  pkgDirPath,
  validationErrs
): Promise<Array<LibDef>> {
  const repoPath = path.relative(pkgDirPath, '..');
  const pkgVersionStr = versionToString(pkgVersion);
  const pkgDirItems = await fs.readdir(pkgDirPath);

  const commonTestFiles = [];
  const flowDirs = [];
  pkgDirItems.forEach(pkgDirItem => {
    const pkgDirItemPath = path.join(pkgDirPath, pkgDirItem);
    const pkgDirItemContext = path.relative(repoPath, pkgDirItemPath);

    const pkgDirItemStat = fs.statSync(pkgDirItemPath);
    if (pkgDirItemStat.isFile()) {
      if (path.extname(pkgDirItem) === '.swp') {
        return;
      }

      const isValidTestFile = validateTestFile(
        pkgDirItemPath,
        pkgDirItemContext,
        validationErrs
      );

      if (isValidTestFile) {
        commonTestFiles.push(pkgDirItemPath);
      }
    } else if (pkgDirItemStat.isDirectory()) {
      flowDirs.push([
        pkgDirItemPath,
        parsePkgFlowDirVersion(pkgDirItemPath, validationErrs)
      ]);
    } else {
      const error = 'Unexpected directory item';
      validationError(pkgDirItemContext, error, validationErrs);
    }
  });

  if (!disjointVersionsAll(flowDirs.map(([_, ver]) => ver))) {
    validationError(pkgDirPath, 'Flow versions not disjoint!', validationErrs);
  }

  if (flowDirs.length === 0) {
    validationError(pkgDirPath, 'No libdef files found!', validationErrs);
  }

  const libDefs = [];
  await P.all(flowDirs.map(async ([flowDirPath, flowVersion]) => {
    const testFilePaths = [].concat(commonTestFiles);
    const basePkgName =
      pkgName.charAt(0) === '@'
      ? pkgName.split(path.sep).pop()
      : pkgName;
    const libDefFileName = `${basePkgName}_${pkgVersionStr}.js`;
    let libDefFilePath;
    (await fs.readdir(flowDirPath)).forEach(flowDirItem => {
      const flowDirItemPath = path.join(flowDirPath, flowDirItem);
      const flowDirItemContext = path.relative(repoPath, flowDirItemPath);
      const flowDirItemStat = fs.statSync(flowDirItemPath);
      if (flowDirItemStat.isFile()) {
        // If we couldn't discern the package name, we've already recorded an
        // error for that -- so try to avoid spurious downstream errors.
        if (pkgName === 'ERROR') {
          return;
        }

        if (path.extname(flowDirItem) === '.swp') {
          return;
        }

        if (flowDirItem === libDefFileName) {
          libDefFilePath = path.join(flowDirPath, flowDirItem);
          return;
        }

        const isValidTestFile = validateTestFile(
          flowDirItemPath,
          flowDirItemContext,
          validationErrs
        );

        if (isValidTestFile) {
          testFilePaths.push(flowDirItemPath);
        }
      } else {
        const error = 'Unexpected directory item';
        validationError(flowDirItemContext, error, validationErrs);
      }
    });

    if (libDefFilePath == null) {
      libDefFilePath = path.join(flowDirPath, libDefFileName);
      if (pkgName !== 'ERROR') {
        const error = 'No libdef file found!';
        validationError(flowDirPath, error, validationErrs);
      }
      return;
    }

    libDefs.push({
      pkgName,
      pkgVersionStr,
      flowVersion: flowVersion,
      flowVersionStr: flowVerToDirString(flowVersion),
      path: libDefFilePath,
      testFilePaths,
    });
  }));
  return libDefs;
}

/**
 * Given the path to a directory item in the 'definitions' directory, parse the
 * directory's name into a package name and version.
 */
const REPO_DIR_ITEM_NAME_RE = /^(.*)_v([0-9]+)\.([0-9]+|x)\.([0-9]+|x)$/;
function parseRepoDirItem(dirItemPath, validationErrs) {
  const dirItem = path.basename(dirItemPath);
  const itemMatches = dirItem.match(REPO_DIR_ITEM_NAME_RE);
  if (itemMatches == null) {
    const error =
      `'${dirItem}' is a malformed definitions/npm/ directory name! ` +
      `Expected the name to be formatted as <PKGNAME>_v<MAJOR>.<MINOR>.<PATCH>`;
    validationError(dirItem, error, validationErrs);
    const pkgName = 'ERROR';
    const pkgVersion = emptyVersion();
    return {pkgName, pkgVersion};
  }

  let [_, pkgName, major, minor, patch] = itemMatches;
  const item = path.dirname(dirItemPath).split(path.sep).pop();
  if (item.charAt(0) === '@') {
    pkgName = `${item}${path.sep}${pkgName}`;
  }
  major =
    validateVersionNumPart(major, "major", dirItemPath, validationErrs);
  minor =
    validateVersionPart(minor, "minor", dirItemPath, validationErrs);
  patch =
    validateVersionPart(patch, "patch", dirItemPath, validationErrs);

  return {pkgName, pkgVersion: {major, minor, patch}};
}

/**
 * Given a path to an assumed test file, ensure that it is named as expected.
 */
const TEST_FILE_NAME_RE = /^test_.*\.js$/;
function validateTestFile(testFilePath, context, validationErrs) {
  const testFileName = path.basename(testFilePath);
  if (!TEST_FILE_NAME_RE.test(testFileName)) {
    const error =
      "Malformed test file name! Test files must be formatted as test_(.*).js";
    validationError(context, error, validationErrs);
    return false;
  }
  return true;
}

/**
 * Given a number-only part of a version string (i.e. the `major` part), parse
 * the string into a number.
 */
function validateVersionNumPart(part, partName, context, validationErrs?) {
  const num = parseInt(part, 10);
  if (String(num) !== part) {
    const error =
      `'${context}': Invalid ${partName} number: '${part}'. Expected a number.`;
    validationError(context, error, validationErrs);
  }
  return num;
}

/**
 * Given a number-or-wildcard part of a version string (i.e. a `minor` or
 * `patch` part), parse the string into either a number or 'x'.
 */
function validateVersionPart(part, partName, context, validationErrs?) {
  if (part === "x") {
    return part;
  }
  return validateVersionNumPart(part, partName, context, validationErrs);
}

/**
 * Given a path to a 'definitions' dir, assert that the currently-running
 * version of the CLI is compatible with the repo.
 */
async function verifyCLIVersion(defsDirPath) {
  const metadataFilePath = path.join(defsDirPath, '.cli-metadata.json');
  const metadata = JSON.parse(String(await fs.readFile(metadataFilePath)));
  if (!metadata.compatibleCLIRange) {
    throw new Error(
      `Unable to find the 'compatibleCLIRange' property in ` +
      `${metadataFilePath}. You might need to update to a newer version of ` +
      `the Flow CLI.`
    );
  }
  const minCLIVersion = metadata.compatibleCLIRange;
  const thisCLIVersion = require('../../package.json').version;
  if (!semver.satisfies(thisCLIVersion, minCLIVersion)) {
    throw new Error(
      `Please upgrade your CLI version! This CLI is version ` +
      `${thisCLIVersion}, but the latest flow-typed definitions are only ` +
      `compatible with flow-typed@${minCLIVersion}`
    );
  }
}

/**
 * Helper function to write verbose output only when an output stream was
 * provided.
 */
type VerboseOutput = stream$Writable | tty$WriteStream;
function writeVerbose(stream, msg, writeNewline = true) {
  if (stream != null) {
    stream.write(msg + (writeNewline ? '\n' : ''));
  }
}

/**
 * Get a list of LibDefs from the local repo.
 *
 * Note that this is mainly only useful while working on the flow-typed repo
 * itself. It is useless when running the npm-install CLI.
 */
const GIT_REPO_DEFS_DIR = path.join(GIT_REPO_DIR, 'definitions', 'npm');
export async function getLocalLibDefs(validationErrs?: VErrors) {
  await verifyCLIVersion(path.join(GIT_REPO_DIR, 'definitions'));
  return getLibDefs(GIT_REPO_DEFS_DIR, validationErrs);
};

/**
 * Get a list of LibDefs from the flow-typed cache repo checkout.
 *
 * If the repo checkout does not exist or is out of date, it will be
 * created/updated automatically first.
 */
const CACHE_REPO_DEFS_DIR = path.join(CACHE_REPO_DIR, 'definitions', 'npm');
export async function getCacheLibDefs(
  verbose?: VerboseOutput = process.stdout,
  validationErrs?: VErrors,
) {
  await ensureCacheRepo(verbose);
  await verifyCLIVersion(path.join(CACHE_REPO_DIR, 'definitions'));
  return getLibDefs(CACHE_REPO_DEFS_DIR, validationErrs);
};

export async function getCacheLibDefVersion(libDef: LibDef) {
  await ensureCacheRepo();
  await verifyCLIVersion(path.join(CACHE_REPO_DIR, 'definitions'));
  const latestCommitHash = await findLatestFileCommitHash(
    CACHE_REPO_DIR,
    path.relative(CACHE_REPO_DIR, libDef.path)
  );
  return (
    `${latestCommitHash.substr(0, 10)}/` +
    `${libDef.pkgName}_${libDef.pkgVersionStr}/` +
    `flow_${libDef.flowVersionStr}`
  );
};

function packageNameMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function libdefMatchesPackageVersion(pkgSemver: string, defVersionRaw: string): boolean {
  // The libdef version should be treated as a semver prefixed by a carat
  // (i.e: "foo_v2.2.x" is the same range as "^2.2.x")
  // UNLESS it is prefixed by the equals character (i.e. "foo_=v2.2.x")
  let defVersion = defVersionRaw;
  if (defVersionRaw[0] !== '=' && defVersionRaw[0] !== '^') {
    defVersion = '^' + defVersionRaw;
  }

  if(semver.valid(pkgSemver)) {
    // test the single package version against the libdef range
    return semver.satisfies(pkgSemver, defVersion);
  }

  if(semver.valid(defVersion)) {
    // test the single defVersion agains the package range
    return semver.satisfies(defVersion, pkgSemver);
  }

  const pkgRange = new semver.Range(pkgSemver);
  const defRange = new semver.Range(defVersion);

  if(defRange.set[0].length !== 2) {
    throw Error("Invalid libDef version, It appears to be a non-contiguous range.");
  }

  const defLowerB = defRange.set[0][0].semver.version;
  const defUpperB = defRange.set[0][1].semver.version;

  if(semver.gtr(defLowerB, pkgSemver) || semver.ltr(defUpperB, pkgSemver)) {
    return false;
  }

  const pkgLowerB = pkgRange.set[0][0].semver.version;
  return defRange.test(pkgLowerB);
}

/**
 * Filter a given list of LibDefs down using a specified filter.
 */
type LibDefFilter =
  | {|type: 'fuzzy', flowVersionStr?: string, term: string|}
  | {|type: 'exact', flowVersionStr?: string, pkgName: string, pkgVersionStr: string|}
  | {|type: 'exact-name', flowVersionStr?: string, term: string|}
;
export function filterLibDefs(
  defs: Array<LibDef>,
  filter: LibDefFilter,
): Array<LibDef> {
  return defs.filter((def: LibDef) => {
    let filterMatch = false;
    switch (filter.type) {
      case 'exact':
        filterMatch = (
          packageNameMatch(def.pkgName, filter.pkgName)
          && libdefMatchesPackageVersion(filter.pkgVersionStr, def.pkgVersionStr)
        );
        break;

      case 'exact-name':
        filterMatch = (
          packageNameMatch(def.pkgName, filter.term)
        );
        break;

      case 'fuzzy':
        filterMatch = (
          def.pkgName.toLowerCase().indexOf(filter.term.toLowerCase()) !== -1
        );
        break;

      default:
        throw new Error(
          `'${filter.type}' is an unexpected filter type! This should never ` +
          `happen!`
        );
    }

    if (!filterMatch) {
      return false;
    }

    const filterFlowVerStr = filter.flowVersionStr;
    if (filterFlowVerStr) {
      const {flowVersion} = def;
      switch (flowVersion.kind) {
        case 'all':
          return semver.satisfies(
            filterFlowVerStr,
            def.flowVersionStr
          );
        case 'specific':
          return semver.satisfies(
            filterFlowVerStr,
            def.flowVersionStr
          );
        case 'ranged':
          const {upper} = flowVersion;
          if (upper) {
            const lowerSpecific = {
              kind: 'ranged',
              upper: null,
              lower: flowVersion.lower,
            };
            const lowerSpecificSemver = flowVerToSemver(lowerSpecific);
            const upperSpecificSemver = flowVerToSemver({
              kind: 'specific',
              ver: upper,
            });
            return (
              semver.satisfies(filterFlowVerStr, lowerSpecificSemver)
              && semver.satisfies(filterFlowVerStr, upperSpecificSemver)
            );
          } else {
            return semver.satisfies(
              filterFlowVerStr,
              def.flowVersionStr,
            );
          }

        default: (flowVersion: empty); throw new Error('Unexpected FlowVersion kind!');
      }
    }

    return true;
  }).sort((a, b) => {
    const aZeroed = a.pkgVersionStr.replace(/x/g, '0');
    const bZeroed = b.pkgVersionStr.replace(/x/g, '0');
    return semver.gt(aZeroed, bZeroed) ? -1 : 1;
  });
};
