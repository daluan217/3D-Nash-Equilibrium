const { execFileSync } = require('child_process');
const path = require('path');

// execFileSync, not execSync: appPath is interpolated from productName, and
// `$(...)` and backticks are still live INSIDE double quotes. Measured — a
// productName of `Bad$(touch /tmp/pwned)` ran the touch at build time under
// the quoted execSync spelling and does nothing here. The value is ours today,
// so this is a hole with no instance rather than a live defect; it is one line
// to remove it, and the review mirror renames the product.
exports.default = async ({ appOutDir, packager }) => {
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  console.log(`Ad-hoc signing: ${appPath}`);
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
