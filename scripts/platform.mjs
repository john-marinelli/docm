function supported(platform){
  if(!platform||!((platform.os==='darwin'&&platform.arch==='arm64')||(platform.os==='linux'&&platform.arch==='x64')))throw new Error('Packaging supports only native macOS arm64 and Linux x64');
  return platform;
}

export function hostPlatform(){
  return supported({os:process.platform,arch:process.arch});
}
export function packageDirectory(platform=hostPlatform()){
  return supported(platform).os==='darwin'?'dist/mac-arm64/Docm.app':'dist/linux-unpacked';
}
export function launcherRelative(platform=hostPlatform()){
  return supported(platform).os==='darwin'?'Contents/Resources/bin/docm':'resources/bin/docm';
}
