import nodeFetch from 'node-fetch';
import { createProgram } from 'typescript/lib/typescript';
import { resolve, basename, extname } from 'path';
import { sync as globSync } from 'globby';
import * as github from '@actions/github';

import {
  GitHubCommitComparison,
  tsProgram,
  RelativeRef,
  ActionEnv,
} from './types';

console.log(github.context);

const DEFAULTS = {
  INDIVIDUAL_FUNCTION_REGEX:
    '(functions/(?!index\\.ts$).*\\.ts|(.*)\\.function\\.ts)$',
  FULL_DEPLOYMENT_REGEX:
    '((tsconfig|package).json|yarn.lock|src/(functions/)?index.ts)$',
};

const {
  COMPARE_URL,
  BEFORE_SHA,
  AFTER_SHA,
  GITHUB_TOKEN,
  GITHUB_WORKSPACE,
  FULL_DEPLOYMENT_REGEX = DEFAULTS.FULL_DEPLOYMENT_REGEX,
  INDIVIDUAL_FUNCTION_REGEX = DEFAULTS.INDIVIDUAL_FUNCTION_REGEX,
  INDIVIDUAL_FUNCTION_GLOB,
  FILE_CHANGES_REGEX_FILTER,
} = process.env as ActionEnv;

const getCompareUrl = (baseUrl: string, base: string, head: string): string =>
  baseUrl
    .replace('{base}', base.substr(0, 7))
    .replace('{head}', head.substr(0, 7));

const fetchGithubComparison = (
  url: string,
  authToken: string
): Promise<GitHubCommitComparison> =>
  nodeFetch(url, {
    headers: { Authorization: 'Bearer ' + authToken },
  }).then((res) => res.json());

async function getCodeFilesChanged(): Promise<string[]> {
  const compareUrl = getCompareUrl(COMPARE_URL, BEFORE_SHA, AFTER_SHA);
  const { files } = await fetchGithubComparison(compareUrl, GITHUB_TOKEN);

  const filepaths = files.map((file) => file.filename);

  if (FILE_CHANGES_REGEX_FILTER) {
    const fileChangesFilter = new RegExp(FILE_CHANGES_REGEX_FILTER);

    return filepaths.filter((filepath) => fileChangesFilter.test(filepath));
  }

  return filepaths;
}

function findFunctionsChanged(
  originPaths: string[],
  references: RelativeRef
): string[] {
  const functionsChanged = [];
  const individualFunction = new RegExp(INDIVIDUAL_FUNCTION_REGEX);

  const dependents = originPaths
    .map((filepath) => references[filepath])
    .filter(Boolean)
    .reduce((acc, arr) => acc.concat(arr), [])
    .filter((item, index, arr) => arr.indexOf(item) === index);

  // files that are not function exports
  const nonFunctionDependents = dependents.filter(
    (filepath) => !individualFunction.test(filepath)
  );

  functionsChanged.push(
    ...dependents.filter((filepath) => individualFunction.test(filepath)),
    ...originPaths.filter((filepath) => individualFunction.test(filepath))
  );

  if (nonFunctionDependents.length) {
    functionsChanged.push(
      ...findFunctionsChanged(nonFunctionDependents, references)
    );
  }

  const functionNames = functionsChanged
    .map((filepath) => basename(filepath, extname(filepath)))
    .filter((item, index, arr) => arr.indexOf(item) === index);

  return functionNames;
}

function processChangedFiles(filepaths: string[]): string[] {
  if (!INDIVIDUAL_FUNCTION_GLOB || !filepaths.length) return [];

  // TODO: change this into a glob environment variable
  const fullDeployment = new RegExp(FULL_DEPLOYMENT_REGEX);

  if (filepaths.some((filepath) => fullDeployment.test(filepath))) return [];

  const changedFilepaths = filepaths.map((filepath) =>
    resolve(GITHUB_WORKSPACE, filepath)
  );
  const functionFilePaths = globSync(INDIVIDUAL_FUNCTION_GLOB, {
    cwd: GITHUB_WORKSPACE,
  });
  const tsProgram = createProgram(functionFilePaths, {});
  const refFileMap = (tsProgram as tsProgram).getRefFileMap();

  if (!refFileMap) return [];

  const relativeReferences = [...Array.from(refFileMap.entries())]
    .filter((pair) =>
      pair[1].every(
        (ref) =>
          !ref.file.includes('node_modules') &&
          !ref.referencedFileName.includes('node_modules')
      )
    )
    .map(([origin, refFiles]) => [origin, refFiles.map((ref) => ref.file)])
    .reduce((acc, pair) => ({ ...acc, [pair[0] as string]: pair[1] }), {});

  return findFunctionsChanged(changedFilepaths, relativeReferences);
}

if (
  COMPARE_URL &&
  BEFORE_SHA &&
  AFTER_SHA &&
  GITHUB_TOKEN &&
  GITHUB_WORKSPACE &&
  FULL_DEPLOYMENT_REGEX &&
  INDIVIDUAL_FUNCTION_REGEX &&
  INDIVIDUAL_FUNCTION_GLOB
) {
  getCodeFilesChanged()
    .then(processChangedFiles)
    .then((changedFunctionNames) => {
      if (!changedFunctionNames.length) {
        return console.log('');
      }

      console.log(':' + changedFunctionNames.join(','));
    })
    .catch(() => {});
}