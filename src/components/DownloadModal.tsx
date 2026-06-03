/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  X,
  Download,
  Terminal,
  Check,
  Copy,
  Laptop,
  AlertCircle,
  HelpCircle,
  FileCode,
  Chrome
} from 'lucide-react';

interface DownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DownloadModal: React.FC<DownloadModalProps> = ({ isOpen, onClose }) => {
  const [downloading, setDownloading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleDownloadDmg = async () => {
    setDownloading(true);
    setErrorMsg(null);

    try {
      // Check if DMG exists before triggering download
      const res = await fetch('/api/download/dmg', { method: 'HEAD' }).catch(() =>
        fetch('/api/download/dmg')
      );

      if (!res.ok || res.headers.get('content-type')?.includes('application/json')) {
        const data = res.headers.get('content-type')?.includes('application/json')
          ? await res.json()
          : {};
        setErrorMsg(data.message || 'No pre-compiled macOS installer found on the server.');
        setDownloading(false);
        return;
      }

      // Let the browser handle the download natively (avoids loading 120MB into JS heap)
      const a = document.createElement('a');
      a.href = '/api/download/dmg';
      a.download = 'Nash Equilibrium Simulator.dmg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setDownloading(false);
    } catch (err: any) {
      console.error(err);
      setErrorMsg('Could not reach the server. Please try again.');
      setDownloading(false);
    }
  };

  const copyCode = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(id);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const cloneCommands = `git clone https://github.com/your-username/nash-equilibrium-simulator.git\ncd nash-equilibrium-simulator`;
  const installCommands = `npm install`;
  const buildCommands = `npm run build && npm run electron:dist`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 selection:bg-indigo-500/30 selection:text-indigo-900 dark:selection:text-indigo-100">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-xs transition-opacity duration-300 cursor-pointer"
        onClick={onClose}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[90vh] md:max-h-[85vh] animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-850 flex items-center justify-between bg-slate-50 dark:bg-slate-950/40">
          <div className="flex items-center gap-2.5">
            <span className="p-1.5 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 rounded-xl">
              <Laptop className="w-5 h-5" />
            </span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-sm md:text-base leading-tight">
                macOS Desktop App Installer
              </h3>
              <p className="text-[10px] md:text-[11px] text-slate-500 dark:text-slate-400">
                Run the Nash Equilibrium Simulator as a native macOS app.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 md:p-6 space-y-6">
          
          {/* Main Download Button and Banner */}
          <div className="bg-gradient-to-br from-indigo-50/50 via-slate-50/40 to-white dark:from-slate-950/40 dark:to-slate-900 border border-slate-150 dark:border-slate-800 rounded-2xl p-5 text-center flex flex-col items-center">
            <div className="w-12 h-12 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 shadow-sm mb-4">
              <Download className="w-6 h-6 animate-bounce" />
            </div>
            
            <h4 className="font-bold text-slate-800 dark:text-white text-sm md:text-base mb-1">
              Download Mac App DMG Installer
            </h4>
            <p className="text-[11px] md:text-xs text-slate-500 dark:text-slate-400 max-w-sm mb-5 leading-normal font-medium">
              Get the standard macOS volume file. Mount the disk, copy the app to your Applications folder, and launch instantly!
            </p>

            <button
              onClick={handleDownloadDmg}
              disabled={downloading}
              className="w-full sm:w-auto px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl shadow-md transition-all hover:translate-y-[-1px] active:translate-y-[1px] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {downloading ? 'Searching server package...' : 'Download macOS App (.dmg)'}
            </button>
          </div>

          {/* Conditional Guidance / Warnings */}
          {errorMsg && (
            <div className="p-4 rounded-xl border border-amber-250 dark:border-amber-900/40 bg-amber-50/20 dark:bg-amber-950/10 text-slate-700 dark:text-slate-300 text-xs leading-relaxed space-y-3">
              <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400 font-bold">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>DMG App Not Compiled On Server Yet</span>
              </div>
              <p className="text-[11px] md:text-xs font-medium text-slate-500 dark:text-slate-450 leading-relaxed pl-6">
                Because this is an active cloud web sandbox, the final macOS installer hasn't been compiled into the server's build directory yet (building DMG binaries requires macOS environment libraries or packaging tools not typically cached inside ephemeral cloud containers).
              </p>
              <div className="pl-6 pt-1">
                <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wide mb-2 flex items-center gap-1">
                  <Terminal className="w-3.5 h-3.5 text-indigo-500" />
                  Self-Service Desktop Compiler (Mac guide):
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-350 font-medium mb-3">
                  If you are working on your own Mac machine, you have the full codebase! You can build your own macOS `.dmg` entirely locally in 10 seconds:
                </p>

                {/* Steps container */}
                <div className="space-y-3.5 mt-2">
                  {/* Step 1 */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Step 1 — Install dependencies</span>
                      <button
                        onClick={() => copyCode(installCommands, 'inst')}
                        className="text-[10px] text-indigo-500 hover:text-indigo-600 font-bold flex items-center gap-1 cursor-pointer"
                      >
                        {copiedText === 'inst' ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                        Copy command
                      </button>
                    </div>
                    <pre className="p-2 border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-mono text-[10px] text-slate-600 dark:text-slate-400 rounded-lg overflow-x-auto">
                      {installCommands}
                    </pre>
                  </div>

                  {/* Step 2 */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Step 2 — Pack macOS DMG Installer</span>
                      <button
                        onClick={() => copyCode(buildCommands, 'build')}
                        className="text-[10px] text-indigo-500 hover:text-indigo-600 font-bold flex items-center gap-1 cursor-pointer"
                      >
                        {copiedText === 'build' ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                        Copy command
                      </button>
                    </div>
                    <pre className="p-2 border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-mono text-[10px] text-slate-600 dark:text-slate-400 rounded-lg overflow-x-auto">
                      {buildCommands}
                    </pre>
                  </div>
                </div>

                <div className="mt-4 p-3 bg-indigo-50/10 dark:bg-indigo-950/10 rounded-xl border border-indigo-100 dark:border-indigo-900 border-dashed text-[10px] text-slate-500 dark:text-slate-400 leading-normal">
                  <span className="font-bold text-indigo-600 dark:text-indigo-400 block mb-0.5">Where does it compile?</span>
                  Your finished, un-sandboxed executable file will appear instantly in a newly generated <code className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-[9.5px]">dist-electron/</code> folder in your directory, fully ready for distribution!
                </div>
              </div>
            </div>
          )}

          {/* macOS Gatekeeper notice — always visible */}
          <div className="border border-amber-200 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/10 rounded-xl p-4 space-y-3">
            <h5 className="font-bold text-amber-700 dark:text-amber-400 text-xs flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 shrink-0" /> macOS Security — One-Time Step After Download
            </h5>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
              Because this app is not notarized through Apple, macOS will show an <strong className="text-slate-700 dark:text-slate-300">"unidentified developer"</strong> warning on first launch. Follow these steps to open it:
            </p>
            <ol className="space-y-1.5 list-none">
              {[
                <>Drag <strong className="text-slate-700 dark:text-slate-300">Nash Equilibrium Simulator</strong> from the DMG into your <strong className="text-slate-700 dark:text-slate-300">Applications</strong> folder.</>,
                <>Double-click the app. When the warning appears, click <strong className="text-slate-700 dark:text-slate-300">Cancel</strong> (not Move to Trash).</>,
                <>Open <strong className="text-slate-700 dark:text-slate-300">System Settings → Privacy &amp; Security</strong>.</>,
                <>Scroll down to find <em>"Nash Equilibrium Simulator was blocked"</em> and click <strong className="text-slate-700 dark:text-slate-300">Open Anyway</strong>.</>,
                <>Double-click the app again and click <strong className="text-slate-700 dark:text-slate-300">Open</strong> to confirm. You only need to do this once.</>,
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                  <span className="shrink-0 w-4 h-4 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-[9px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* Offline DB note */}
          <div className="border-t border-slate-150 dark:border-slate-800/80 pt-3 pr-2">
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              <strong className="text-slate-700 dark:text-slate-300">Offline mode:</strong> The desktop app stores all data locally — no account needed. Enable Cloud Sync in Settings to share games with the website.
            </p>
          </div>

        </div>

        {/* Footer */}
        <div className="p-3.5 px-6 border-t border-slate-200 dark:border-slate-850 flex justify-end bg-slate-50 dark:bg-slate-950/40">
          <button
            onClick={onClose}
            className="px-4.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
          >
            Close Dialog
          </button>
        </div>

      </div>
    </div>
  );
};
