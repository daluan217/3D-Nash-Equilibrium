// Read-only: print the number of ON-SCREEN windows owned by one pid (no input events).
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
print(list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.count)
