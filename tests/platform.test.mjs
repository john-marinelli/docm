import {expect,it} from 'vitest';
import {executableRelative,launcherRelative,nodeResourceUrl,packageDirectory,platformKey,pnpmResourceUrl} from '../scripts/platform.mjs';


it.each([{os:'linux',arch:'arm64'},{os:'darwin',arch:'x64'},{os:'win32',arch:'x64'},null])('rejects unsupported targets consistently',platform=>{
  for(const helper of [platformKey,packageDirectory,launcherRelative,executableRelative])expect(()=>helper(platform)).toThrow(/only native macOS arm64 and Linux x64/);
  for(const helper of [nodeResourceUrl,pnpmResourceUrl])expect(()=>helper('26.10.0',platform)).toThrow(/only native macOS arm64 and Linux x64/);
});
