function supported(platform){
  if(!platform||!((platform.os==='darwin'&&platform.arch==='arm64')||(platform.os==='linux'&&platform.arch==='x64')))throw new Error('Formula preparation/build supports only native macOS arm64 and Linux x64');
  return platform;
}

export function hostPlatform(){
  return supported({os:process.platform,arch:process.arch});
}
export function platformKey(platform=hostPlatform()){
  const {os,arch}=supported(platform);
  return `${os}-${arch}`;
}
export function nodeResourceUrl(version,platform=hostPlatform()){
  return `https://nodejs.org/dist/v${version}/node-v${version}-${platformKey(platform)}.tar.xz`;
}
export function pnpmResourceUrl(version,platform=hostPlatform()){
  const target=platformKey(platform);
  return `https://registry.npmjs.org/@pnpm/exe.${target}/-/exe.${target}-${version}.tgz`;
}
export function packageDirectory(platform=hostPlatform()){
  return supported(platform).os==='darwin'?'dist/mac-arm64/Docm.app':'dist/linux-unpacked';
}
export function launcherRelative(platform=hostPlatform()){
  return supported(platform).os==='darwin'?'Contents/Resources/bin/docm':'resources/bin/docm';
}
export function executableRelative(platform=hostPlatform()){
  return supported(platform).os==='darwin'?'Contents/MacOS/docm':'docm';
}
