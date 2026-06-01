const { execSync } = require('child_process');
const path = require('path');

// Runs after electron-builder packs the .app but before DMG creation.
// Ad-hoc signs the app so macOS shows "unidentified developer" + Open Anyway
// instead of "damaged and can't be opened".
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`  • ad-hoc signing  path=${appPath}`);
  execSync(`xattr -cr "${appPath}"`);
  execSync(`codesign --sign - --deep --force --options runtime "${appPath}"`);
  console.log('  • ad-hoc signing done');
};
