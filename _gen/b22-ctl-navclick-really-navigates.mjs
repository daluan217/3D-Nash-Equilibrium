// CONTROL for the navigation probe: the SAME DOM-click mechanism, aimed at a
// SAME-ORIGIN url the app has no reason to refuse. If this does not navigate,
// the clicks are inert and every "refused" above is a harness artifact.
import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const WT='/Users/danielluan/.claude/jobs/b9eb89b4/tmp/scratchpad/wt-blue-desktop-loop-22';
const udd=mkdtempSync(join(tmpdir(),'nash-navctl-'));
const app=await electron.launch({
  executablePath: join(WT,'dist-electron/mac-arm64/Nash Equilibrium Simulator.app/Contents/MacOS/Nash Equilibrium Simulator'),
  args:[`--user-data-dir=${udd}`], cwd:'/tmp',
  env:{IS_ELECTRON:'true',NODE_ENV:'production',PATH:process.env.PATH,HOME:process.env.HOME}});
const win=await app.firstWindow(); await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(2500);
const before=win.url();
await win.evaluate(()=>{const a=document.createElement('a');a.id='ctl';a.href='/api/health';a.textContent='ctl';document.body.appendChild(a);});
await win.evaluate(()=>document.getElementById('ctl').click());
await win.waitForTimeout(1500);
const after=win.url();
console.log('before:',before); console.log('after :',after);
console.log(after!==before && after.includes('/api/health')
  ? 'CONTROL OK: the DOM click really navigates when the app permits it'
  : '*** CONTROL FAILED: click is inert -> the 8 "refused" results are vacuous');
await app.close(); process.exit(0);
