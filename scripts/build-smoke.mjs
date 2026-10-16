import {prepare} from './prepare-formula.mjs';
import {smokeSource} from './source-smoke.mjs';

await smokeSource(await prepare());
