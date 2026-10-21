// CaptureProHelper (macOS) — same line protocol as native/CaptureProHelper.cs on Windows.
// stdin:  "<id> <cmd> [args]"   stdout: one JSON object per line (responses carry "id", events carry "ev").
// Commands: ping | foreground | windows | monitors | idle | hook on|off | mouse on|off
// Coordinates are in points with the origin at the top-left of the main display (= Electron DIP);
// monitors carry their pixel `scale` (2 on Retina).
// Build: swiftc -O CaptureProHelper.swift -o CaptureProHelper -framework AppKit
import AppKit
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let outLock = NSLock()

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
        let line = String(data: data, encoding: .utf8) else { return }
  outLock.lock()
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  outLock.unlock()
}

func reply(_ id: String, _ body: [String: Any]) {
  var obj = body
  obj["id"] = id
  emit(obj)
}

// ---- displays ---------------------------------------------------------------
func activeDisplays() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  return Array(ids.prefix(Int(count)))
}

// Order matches ffmpeg's AVFoundation "Capture screen N" devices (also CGGetActiveDisplayList).
func monitorsJSON() -> [[String: Any]] {
  var out: [[String: Any]] = []
  for (i, id) in activeDisplays().enumerated() {
    let b = CGDisplayBounds(id)
    var scale = 1.0
    if let mode = CGDisplayCopyDisplayMode(id), b.width > 0 { scale = Double(mode.pixelWidth) / Double(b.width) }
    out.append([
      "index": i, "hmonitor": Int(id),
      "x": Int(b.origin.x), "y": Int(b.origin.y), "w": Int(b.width), "h": Int(b.height),
      "primary": CGDisplayIsMain(id) != 0, "scale": scale,
    ])
  }
  return out
}

// ---- windows ----------------------------------------------------------------
func windowInfos() -> [[String: Any]] {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
  return list
}

func windowJSON(_ w: [String: Any]) -> [String: Any]? {
  guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
        let num = w[kCGWindowNumber as String] as? Int,
        let pid = w[kCGWindowOwnerPID as String] as? Int,
        let bd = w[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: bd as CFDictionary) else { return nil }
  let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
  let name = (w[kCGWindowName as String] as? String) ?? ""
  var fullscreen = false
  for id in activeDisplays() where CGDisplayBounds(id).equalTo(rect) { fullscreen = true }
  return [
    "hwnd": num, "title": name.isEmpty ? owner : name, "class": "", "exe": owner, "pid": pid,
    "x": Int(rect.origin.x), "y": Int(rect.origin.y), "w": Int(rect.width), "h": Int(rect.height),
    "fullscreen": fullscreen,
  ]
}

func listWindows() -> [[String: Any]] {
  return windowInfos().compactMap(windowJSON).filter { ($0["w"] as? Int ?? 0) > 50 && ($0["h"] as? Int ?? 0) > 50 }
}

func foregroundWindow() -> [String: Any] {
  var pid: Int = -1
  DispatchQueue.main.sync { pid = Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1) }
  // Window list is front-to-back: the first normal window of the frontmost app is its active window.
  for w in windowInfos() {
    if let j = windowJSON(w), (j["pid"] as? Int) == pid { return j }
  }
  return ["hwnd": 0, "title": "", "class": "", "exe": "", "pid": pid, "x": 0, "y": 0, "w": 0, "h": 0, "fullscreen": false]
}

// ---- global input (listen-only event tap; needs Input Monitoring permission) ----
var eventTap: CFMachPort?
var tapSource: CFRunLoopSource?
var mouseEvents = false
var modsDown = Set<String>()

let keyNames: [Int64: String] = [
  0x00: "A", 0x0B: "B", 0x08: "C", 0x02: "D", 0x0E: "E", 0x03: "F", 0x05: "G", 0x04: "H", 0x22: "I", 0x26: "J",
  0x28: "K", 0x25: "L", 0x2E: "M", 0x2D: "N", 0x1F: "O", 0x23: "P", 0x0C: "Q", 0x0F: "R", 0x01: "S", 0x11: "T",
  0x20: "U", 0x09: "V", 0x0D: "W", 0x07: "X", 0x10: "Y", 0x06: "Z",
  0x1D: "0", 0x12: "1", 0x13: "2", 0x14: "3", 0x15: "4", 0x17: "5", 0x16: "6", 0x1A: "7", 0x1C: "8", 0x19: "9",
  0x7A: "F1", 0x78: "F2", 0x63: "F3", 0x76: "F4", 0x60: "F5", 0x61: "F6", 0x62: "F7", 0x64: "F8", 0x65: "F9",
  0x6D: "F10", 0x67: "F11", 0x6F: "F12", 0x69: "F13", 0x6B: "F14", 0x71: "F15", 0x6A: "F16", 0x40: "F17",
  0x4F: "F18", 0x50: "F19", 0x5A: "F20",
  0x24: "Enter", 0x4C: "Enter", 0x30: "Tab", 0x31: "Space", 0x33: "Backspace", 0x35: "Esc", 0x75: "Delete",
  0x7B: "Left", 0x7C: "Right", 0x7D: "Down", 0x7E: "Up", 0x73: "Home", 0x77: "End", 0x74: "Page Up", 0x79: "Page Down",
  0x39: "Caps Lock", 0x1B: "-", 0x18: "=", 0x21: "[", 0x1E: "]", 0x29: ";", 0x27: "'", 0x2B: ",", 0x2F: ".",
  0x2C: "/", 0x2A: "\\", 0x32: "`",
  0x38: "Shift", 0x3C: "Shift", 0x3B: "Ctrl", 0x3E: "Ctrl", 0x3A: "Alt", 0x3D: "Alt", 0x37: "Cmd", 0x36: "Cmd",
]

func mods(_ flags: CGEventFlags) -> [String] {
  var m: [String] = []
  if flags.contains(.maskControl) { m.append("Ctrl") }
  if flags.contains(.maskAlternate) { m.append("Alt") }
  if flags.contains(.maskShift) { m.append("Shift") }
  if flags.contains(.maskCommand) { m.append("Cmd") }
  return m
}

func handle(_ type: CGEventType, _ event: CGEvent) {
  switch type {
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    if let t = eventTap { CGEvent.tapEnable(tap: t, enable: true) }
  case .keyDown, .keyUp:
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    emit(["ev": "key", "type": type == .keyDown ? "down" : "up", "vk": Int(code),
          "name": keyNames[code] ?? "Key\(code)", "mods": mods(event.flags)])
  case .flagsChanged:
    // Modifier keys arrive as flag changes: report them as down/up like a normal key.
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    guard let name = keyNames[code], ["Shift", "Ctrl", "Alt", "Cmd", "Caps Lock"].contains(name) else { return }
    let isDown: Bool
    if name == "Caps Lock" { isDown = event.flags.contains(.maskAlphaShift) } else { isDown = mods(event.flags).contains(name) }
    emit(["ev": "key", "type": isDown ? "down" : "up", "vk": Int(code), "name": name, "mods": mods(event.flags)])
  case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel:
    guard mouseEvents else { return }
    let p = event.location
    var kind = "down", btn = "left"
    switch type {
    case .leftMouseUp: kind = "up"
    case .rightMouseDown: btn = "right"
    case .rightMouseUp: kind = "up"; btn = "right"
    case .otherMouseDown: btn = "middle"
    case .otherMouseUp: kind = "up"; btn = "middle"
    case .scrollWheel: kind = "wheel"; btn = "wheel"
    default: break
    }
    emit(["ev": "mouse", "type": kind, "btn": btn, "x": Int(p.x), "y": Int(p.y)])
  default:
    break
  }
}

func tapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
  handle(type, event)
  return Unmanaged.passUnretained(event)
}

func startHooks() -> Bool {
  if eventTap != nil { return true }
  let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown,
                              .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel]
  var mask: CGEventMask = 0
  for t in types { mask |= CGEventMask(1) << CGEventMask(t.rawValue) }
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                    eventsOfInterest: mask, callback: tapCallback, userInfo: nil) else {
    return false // Input Monitoring permission not granted
  }
  guard let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else { return false }
  eventTap = tap
  tapSource = src
  CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  return true
}

func stopHooks() {
  if let t = eventTap { CGEvent.tapEnable(tap: t, enable: false); CFMachPortInvalidate(t) }
  if let s = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
  eventTap = nil
  tapSource = nil
}

// ---- command loop -------------------------------------------------------------
emit(["ev": "ready"])

Thread.detachNewThread {
  while let line = readLine() {
    let parts = line.trimmingCharacters(in: .whitespaces).split(separator: " ").map(String.init)
    if parts.count < 2 { continue }
    let id = parts[0], cmd = parts[1]
    switch cmd {
    case "ping": reply(id, ["ok": true])
    case "foreground": reply(id, foregroundWindow())
    case "windows": reply(id, ["windows": listWindows()])
    case "monitors": reply(id, ["monitors": monitorsJSON()])
    case "idle":
      let anyInput = CGEventType(rawValue: UInt32.max)!
      let secs = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
      reply(id, ["ms": Int(secs * 1000)])
    case "hook":
      if parts.count > 2 && parts[2] == "on" {
        var ok = false
        DispatchQueue.main.sync { ok = startHooks() }
        if ok { reply(id, ["ok": true]) } else {
          reply(id, ["error": "Input Monitoring permission is required for hotkeys (System Settings → Privacy & Security → Input Monitoring)."])
          emit(["ev": "permission", "need": "input-monitoring"])
        }
      } else {
        DispatchQueue.main.sync { stopHooks() }
        reply(id, ["ok": true])
      }
    case "mouse":
      mouseEvents = parts.count > 2 && parts[2] == "on"
      reply(id, ["ok": true])
    default:
      reply(id, ["error": "unknown command"])
    }
  }
  exit(0) // stdin closed: the app has exited
}

RunLoop.main.run()
