import {expect,it} from 'vitest';
import {launcherRelative,packageDirectory} from '../scripts/platform.mjs';

it.each([{os:'linux',arch:'arm64'},{os:'darwin',arch:'x64'},{os:'win32',arch:'x64'},null])('rejects unsupported targets consistently',platform=>{
  for(const helper of [packageDirectory,launcherRelative])expect(()=>helper(platform)).toThrow(/only native macOS arm64 and Linux x64/);
});
