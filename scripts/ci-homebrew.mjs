import path from 'node:path';
import {prepareRelease} from './release.mjs';
import {smokeHomebrew} from './release-smoke.mjs';
import {root} from './prepare-formula.mjs';
import {readVersion} from './version.mjs';

if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Homebrew CI requires a disposable GitHub Actions runner');
const directory=path.join(root,'.build','ci-release');
await prepareRelease({tag:`v${await readVersion()}`,commit:process.env.GITHUB_SHA,repository:process.env.GITHUB_REPOSITORY,output:directory});
await smokeHomebrew(directory,{localAssets:true});
