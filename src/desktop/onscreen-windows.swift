// Read-only window census for one pid (no input events): "<onscreen> <present> <desktopVisible>".
// onscreen: its windows on the CURRENT Space. present: its real windows (>= 100 px tall) on any
// Space. A background launch lands on the desktop Space, so while a fullscreen app owns the
// screen its windows exist but are not "on screen" (measured with VS Code fullscreen).
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let mine = { (w: [String: Any]) in (w[kCGWindowOwnerPID as String] as? Int32) == pid }
let tall = { (w: [String: Any]) in ((w[kCGWindowBounds as String] as? [String: Any])?["Height"] as? Double ?? 0) >= 100 }
let now = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
let desktop = now.contains { ($0[kCGWindowOwnerName as String] as? String) == "Finder" && (($0[kCGWindowLayer as String] as? Int) ?? 0) < 0 }
print(now.filter(mine).count, all.filter { mine($0) && tall($0) && (($0[kCGWindowLayer as String] as? Int) ?? -1) == 0 }.count, desktop)
