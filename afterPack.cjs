const { execSync } = require('child_process');
const path = require('path');

exports.default = async ({ appOutDir, packager }) => {
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  console.log(`Ad-hoc signing: ${appPath}`);
  execSync(`xattr -cr "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
};
