import {expect,it} from 'vitest';
import {archiveName,renderFormula} from '../scripts/formula.mjs';

const sha=character=>character.repeat(64);

it('selects each prebuilt archive by platform',()=>{
  const formula=renderFormula({version:'1.2.3',homepage:'https://github.com/owner/docm',archives:{
    'darwin-arm64':{url:'https://example.com/mac.tar.gz',sha256:sha('a')},
    'linux-x64':{url:'https://example.com/linux.tar.gz',sha256:sha('b')},
  }});
  expect(formula).toMatch(/on_macos do\n {4}depends_on macos: :ventura\n {4}depends_on arch: :arm64\n {4}preserve_rpath\n {4}url 'https:\/\/example.com\/mac.tar.gz'\n {4}sha256 'a{64}'\n {2}end/);
  expect(formula).toMatch(/on_linux do\n {4}depends_on arch: :x86_64\n {4}url 'https:\/\/example.com\/linux.tar.gz'\n {4}sha256 'b{64}'\n {2}end/);
  expect(formula).toContain("version '1.2.3'");
});

it('omits platforms without an archive and rejects an empty or invalid set',()=>{
  const formula=renderFormula({version:'1.2.3',homepage:'https://example.com',archives:{'linux-x64':{url:'file:///dist/linux.tar.gz',sha256:sha('c')}}});
  expect(formula).not.toContain('on_macos');
  expect(()=>renderFormula({version:'1.2.3',homepage:'https://example.com',archives:{}})).toThrow(/at least one/);
  expect(()=>renderFormula({version:'1.2.3',homepage:'https://example.com',archives:{'linux-x64':{url:'x',sha256:'short'}}})).toThrow(/Invalid checksum/);
});

it('names archives as electron-builder produces them',()=>{
  expect(archiveName('1.2.3','darwin-arm64')).toBe('docm-1.2.3-darwin-arm64.tar.gz');
});
