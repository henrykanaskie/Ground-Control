//
//  GroundControl.swift: the macOS shell around the Ground Control dashboard.
//
//  The web application in `public/` and the Node server in `server.js` are
//  finished and untouched. This file is only a host: it finds Node, claims a
//  free port, starts the server as a child it fully owns, waits until the
//  server answers, and then puts the dashboard on screen in a WKWebView with a
//  real menu bar.
//
//  The one thing that must never go wrong is the child's lifetime. Everything
//  in `ServerProcess` exists to guarantee that no `node` outlives this app,
//  including when the app is force-quit and no Swift code of ours ever runs
//  again. See the comment above `spawnScript`.
//
//  Build: see ../build-app.sh
//

import AppKit
import WebKit
import Darwin
import Foundation

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - Palette (CONTRACT.md §3)
// ═══════════════════════════════════════════════════════════════════════════

enum Palette {
    static func hex(_ v: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255,
                green:   CGFloat((v >> 8) & 0xff) / 255,
                blue:    CGFloat(v & 0xff) / 255,
                alpha: 1)
    }
    static let obsidian = hex(0x0a0b0d)   // --bg
    static let panel    = hex(0x15181d)   // --panel
    static let line     = hex(0x252a32)   // --line
    static let text     = hex(0xe8e5df)   // --text
    static let text2    = hex(0xa2a8b3)   // --text-2
    static let ember     = hex(0xf59e0b)  // --ember
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - Where the app's own files live
// ═══════════════════════════════════════════════════════════════════════════

enum Payload {
    /// Directory holding `server.js`, `lib/`, `public/`, `package.json`.
    ///
    /// In a built bundle that is `Contents/Resources`, which `build-app.sh`
    /// fills, so a moved or copied `.app` keeps working. Running the compiled
    /// binary directly (development) falls back to the repository checkout.
    static let directory: URL = {
        if let override = ProcessInfo.processInfo.environment["GROUND_CONTROL_PAYLOAD_DIR"] {
            return URL(fileURLWithPath: override).standardizedFileURL
        }
        if let res = Bundle.main.resourceURL,
           FileManager.default.fileExists(atPath: res.appendingPathComponent("server.js").path) {
            return res.standardizedFileURL
        }
        // Development: <repo>/build/GroundControl or <repo>/app: walk up looking for server.js.
        var dir = Bundle.main.bundleURL.deletingLastPathComponent()
        for _ in 0..<5 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("server.js").path) {
                return dir.standardizedFileURL
            }
            dir = dir.deletingLastPathComponent()
        }
        return Bundle.main.bundleURL.deletingLastPathComponent().standardizedFileURL
    }()

    static var serverJS: URL { directory.appendingPathComponent("server.js") }

    static var isPresent: Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: serverJS.path)
            && fm.fileExists(atPath: directory.appendingPathComponent("public/index.html").path)
    }

    /// The folder of projects to watch. `server.js` has the same default; we
    /// pass it explicitly so the value is visible in `ps` and overridable.
    static var scanRoot: String {
        if let env = ProcessInfo.processInfo.environment["GROUND_CONTROL_ROOT"], !env.isEmpty { return env }
        if let saved = UserDefaults.standard.string(forKey: "scanRoot"), !saved.isEmpty { return saved }
        return (NSHomeDirectory() as NSString).appendingPathComponent("coding_projects")
    }

    static var logFile: URL {
        let dir = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Logs/GroundControl", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("server.log")
    }

    /// `server.js` stages Forge artifacts in `<dir-of-server.js>/.forge`, which
    /// inside a bundle would mean writing into `Contents/Resources`. We cannot
    /// change the server, so we point that path at Application Support with a
    /// symlink instead. Best effort: if anything is already there, leave it.
    static func redirectForgeDirectory() {
        let fm = FileManager.default
        let link = directory.appendingPathComponent(".forge")
        guard Bundle.main.bundleURL.pathExtension == "app" else { return }   // dev checkout: leave alone
        guard !fm.fileExists(atPath: link.path) else { return }
        let store = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/GroundControl/forge", isDirectory: true)
        try? fm.createDirectory(at: store, withIntermediateDirectories: true)
        try? fm.createSymbolicLink(at: link, withDestinationURL: store)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - Finding Node
// ═══════════════════════════════════════════════════════════════════════════

enum NodeFinder {

    /// Probed in order. A GUI process launched from Finder gets a bare
    /// `/usr/bin:/bin:/usr/sbin:/sbin` PATH, so `which node` is useless here,
    /// explicit paths first, the user's login shell only as a fallback.
    static func find() -> String? {
        for path in candidates() where isRunnable(path) { return path }
        if let viaShell = viaLoginShell(), isRunnable(viaShell) { return viaShell }
        return nil
    }

    static func candidates() -> [String] {
        let home = NSHomeDirectory()
        var list = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        // Version managers, checked after the standard locations.
        list += [
            "\(home)/.volta/bin/node",
            "\(home)/.local/bin/node",
            "/opt/local/bin/node",
        ]
        list += versionManagerNodes(under: "\(home)/.nvm/versions/node")
        list += versionManagerNodes(under: "\(home)/.fnm/node-versions", suffix: "installation/bin/node")
        return list
    }

    private static func versionManagerNodes(under root: String,
                                            suffix: String = "bin/node") -> [String] {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: root) else { return [] }
        // Newest-looking version first.
        return entries.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
                      .map { "\(root)/\($0)/\(suffix)" }
    }

    private static func isRunnable(_ path: String) -> Bool {
        var st = stat()
        guard stat(path, &st) == 0 else { return false }
        guard (st.st_mode & S_IFMT) == S_IFREG else { return false }
        return access(path, X_OK) == 0
    }

    /// Last resort: ask the login shell, which has the user's real PATH.
    /// Bounded: a misconfigured shell profile must not hang the launch.
    private static func viaLoginShell() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        guard FileManager.default.isExecutableFile(atPath: shell) else { return nil }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: shell)
        task.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        task.standardOutput = out
        task.standardError = FileHandle.nullDevice
        task.standardInput = FileHandle.nullDevice
        do { try task.run() } catch { return nil }

        var data = Data()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            data = out.fileHandleForReading.readDataToEndOfFile()
            done.signal()
        }
        if done.wait(timeout: .now() + 6) == .timedOut {
            task.terminate()
            return nil
        }
        task.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        let line = text.split(separator: "\n").last.map(String.init)?
            .trimmingCharacters(in: .whitespaces)
        return (line?.isEmpty == false) ? line : nil
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - Claiming a free port
// ═══════════════════════════════════════════════════════════════════════════

enum FreePort {
    /// Bind port 0, read back what the kernel assigned, release it. There is a
    /// theoretical race between releasing and the server binding, but the
    /// alternative (hardcoding 7377) collides with the user's own instance
    /// every time, which is not theoretical at all.
    ///
    /// We probe on 0.0.0.0 because that is what `server.listen(port)` does.
    static func claim() -> UInt16? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = INADDR_ANY

        let bound = withUnsafePointer(to: &addr) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return nil }

        var assigned = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &assigned) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        guard named == 0 else { return nil }

        let port = UInt16(bigEndian: assigned.sin_port)
        return port > 0 ? port : nil
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - The server child process
// ═══════════════════════════════════════════════════════════════════════════

/// The shell wrapper that actually runs Node.
///
/// Two guarantees come out of this script:
///
///  1. **Nothing survives the app.** File descriptor 3 is the read end of a
///     pipe whose write end is held only by this app. The watchdog subshell
///     blocks reading it; the read returns EOF the instant the app's last file
///     descriptor closes: normal quit, crash, or `kill -9`, which no handler
///     of ours could ever catch, and it then takes Node down. This is the
///     answer to "force-quit the app and check `ps`".
///  2. **We learn when the server dies.** The wrapper `wait`s on Node and then
///     exits, so the app's process-exit source fires and can show the
///     "server stopped" screen instead of a blank window.
///
/// The whole trio (`sh`, `node`, watchdog) sits in one process group, so the
/// normal-quit path is a single `killpg`.
private let spawnScript = """
node=$1
server=$2
port=$3
root=$4

"$node" "$server" --port "$port" --root "$root" &
child=$!

# Blocks on fd 3 until the app goes away, then stops the server. `read` is a
# builtin, so this subshell *is* the waiter: no stray helper process.
(
  read -r _ <&3 2>/dev/null
  kill -TERM "$child" 2>/dev/null
  n=0
  while kill -0 "$child" 2>/dev/null && [ "$n" -lt 30 ]; do sleep 0.1; n=$((n + 1)); done
  kill -KILL "$child" 2>/dev/null
) &
watchdog=$!

wait "$child"
status=$?
kill -TERM "$watchdog" 2>/dev/null
exit $status
"""

final class ServerProcess {

    enum StartError: LocalizedError {
        case pipeFailed
        case spawnFailed(Int32)

        var errorDescription: String? {
            switch self {
            case .pipeFailed:          return "could not create the keep-alive pipe"
            case .spawnFailed(let e):  return "could not start the server process (\(String(cString: strerror(e))))"
            }
        }
    }

    let port: UInt16
    let nodePath: String
    let scanRoot: String
    let logURL: URL

    private var pid: pid_t = -1
    /// Remembered separately from `pid`, because once the child is reaped we
    /// still want one final sweep of its group: the watchdog subshell can
    /// outlive a shell that was killed before it could tidy up.
    private var processGroup: pid_t = -1
    private var keepAliveWrite: Int32 = -1
    private var exitSource: DispatchSourceProcess?
    private var deliberateStop = false

    /// Called on the main queue if the server exits while we still want it.
    /// The argument is a human-readable reason, not a raw code: the wrapper
    /// shell sits between us and Node, so the number alone would mislead.
    var onUnexpectedExit: ((String) -> Void)?

    init(nodePath: String, port: UInt16, scanRoot: String, logURL: URL) {
        self.nodePath = nodePath
        self.port = port
        self.scanRoot = scanRoot
        self.logURL = logURL
    }

    var isRunning: Bool { pid > 0 }

    // ───────────────────────────────────────────────────────────────────────

    func start() throws {
        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else { throw StartError.pipeFailed }
        let readEnd = fds[0], writeEnd = fds[1]
        // The child must not inherit the write end, or the pipe would never
        // reach EOF and the watchdog would wait forever.
        _ = fcntl(writeEnd, F_SETFD, FD_CLOEXEC)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, logURL.path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        posix_spawn_file_actions_adddup2(&actions, 1, 2)
        posix_spawn_file_actions_adddup2(&actions, readEnd, 3)

        var attrs: posix_spawnattr_t?
        posix_spawnattr_init(&attrs)
        defer { posix_spawnattr_destroy(&attrs) }
        // Own process group, so one killpg() reaps the shell, Node and the
        // watchdog together, and so nothing we signal can reach this app.
        posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attrs, 0)

        let argv = ["/bin/sh", "-c", spawnScript, "ground-control-server",
                    nodePath, Payload.serverJS.path, String(port), scanRoot]
        let envp = childEnvironment()

        var spawned: pid_t = -1
        let rc = withCStringArray(argv) { cArgv in
            withCStringArray(envp) { cEnv in
                posix_spawn(&spawned, "/bin/sh", &actions, &attrs, cArgv, cEnv)
            }
        }

        close(readEnd)
        guard rc == 0, spawned > 0 else {
            close(writeEnd)
            throw StartError.spawnFailed(rc)
        }

        pid = spawned
        processGroup = spawned           // POSIX_SPAWN_SETPGROUP with pgroup 0
        keepAliveWrite = writeEnd
        watchForExit()
    }

    private func watchForExit() {
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let reason = self.reap()
            self.exitSource?.cancel()
            self.exitSource = nil
            if !self.deliberateStop { self.onUnexpectedExit?(reason) }
        }
        source.resume()
        exitSource = source
    }

    /// Collects the child and describes how it went. `waitpid` can legitimately
    /// come back with nothing to report: someone else may already have reaped
    /// it, so say "unknown" rather than inventing a confident exit code 0.
    @discardableResult
    private func reap() -> String {
        guard pid > 0 else { return "already gone" }
        var status: Int32 = 0
        let r = waitpid(pid, &status, WNOHANG)
        guard r == pid else {
            if r == -1 && errno == ECHILD { pid = -1 }
            return "reason unknown"
        }
        pid = -1
        // WIFSIGNALED / WTERMSIG / WEXITSTATUS, spelled out: the macros are
        // not imported into Swift.
        let signalNumber = status & 0x7f
        if signalNumber != 0 { return "killed by signal \(signalNumber)" }
        return "exit code \((status >> 8) & 0xff)"
    }

    /// Idempotent. Safe to call from `applicationWillTerminate`.
    func stop() {
        guard !deliberateStop else { return }
        deliberateStop = true

        exitSource?.cancel()
        exitSource = nil

        // Closing the pipe alone would be enough (the watchdog would notice),
        // but we do not want to wait a tick for it on a normal quit.
        if keepAliveWrite >= 0 { close(keepAliveWrite); keepAliveWrite = -1 }

        guard processGroup > 0 else { return }
        let group = processGroup
        processGroup = -1
        killpg(group, SIGTERM)

        // Give it a moment to shut its listener down, then insist.
        var waited = 0.0
        while pid > 0 && waited < 2.0 {
            var status: Int32 = 0
            let r = waitpid(pid, &status, WNOHANG)
            if r == pid || (r == -1 && errno == ECHILD) { pid = -1; break }
            usleep(40_000)
            waited += 0.04
        }
        if pid > 0 {
            killpg(group, SIGKILL)
            var status: Int32 = 0
            _ = waitpid(pid, &status, 0)
            pid = -1
        }
        // Final sweep. If the server died on its own, the shell that was
        // supposed to tidy up its watchdog may never have got the chance.
        killpg(group, SIGKILL)
    }

    // ───────────────────────────────────────────────────────────────────────

    private func childEnvironment() -> [String] {
        var env = ProcessInfo.processInfo.environment
        // server.js shells out to `git` via execFile, which resolves through
        // PATH. Under Finder that PATH is minimal, so spell it out.
        var parts = [
            (nodePath as NSString).deletingLastPathComponent,
            "/opt/homebrew/bin", "/usr/local/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]
        if let existing = env["PATH"] { parts += existing.split(separator: ":").map(String.init) }
        var seen = Set<String>()
        env["PATH"] = parts.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
        env["GROUND_CONTROL_HOST_APP"] = "1"
        return env.map { "\($0.key)=\($0.value)" }
    }

    /// Tail of the server log, for error reporting.
    func logTail(lines: Int = 12) -> String {
        guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
        let all = text.split(separator: "\n", omittingEmptySubsequences: false)
        return all.suffix(lines).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Bridges `[String]` to the NULL-terminated `char *[]` posix_spawn wants.
private func withCStringArray<R>(_ strings: [String],
                                 _ body: (UnsafePointer<UnsafeMutablePointer<CChar>?>) -> R) -> R {
    var pointers: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) }
    pointers.append(nil)
    defer { for p in pointers where p != nil { free(p) } }
    return pointers.withUnsafeBufferPointer { body($0.baseAddress!) }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - Readiness probe
// ═══════════════════════════════════════════════════════════════════════════

enum Readiness {
    /// Polls `/api/projects` until it answers or `deadline` passes. Called off
    /// the main thread. Returns false as soon as the server dies, rather than
    /// burning the whole ten seconds on a corpse.
    static func wait(port: UInt16, timeout: TimeInterval, stillAlive: () -> Bool) -> Bool {
        let url = URL(string: "http://127.0.0.1:\(port)/api/projects")!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let session = URLSession(configuration: config)
        let deadline = Date().addingTimeInterval(timeout)

        while Date() < deadline {
            guard stillAlive() else { return false }
            var ok = false
            let done = DispatchSemaphore(value: 0)
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            session.dataTask(with: request) { _, response, _ in
                if let http = response as? HTTPURLResponse, http.statusCode == 200 { ok = true }
                done.signal()
            }.resume()
            _ = done.wait(timeout: .now() + 2.5)
            if ok { return true }
            usleep(150_000)
        }
        return false
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - The obsidian curtain
// ═══════════════════════════════════════════════════════════════════════════

/// Sits behind the web view. It is what the window shows before the first
/// paint (so the launch is obsidian, never white) and what it shows again if
/// the server dies underneath us.
final class CurtainView: NSView {

    private let titleLabel = CurtainView.label(size: 22, weight: .semibold, color: Palette.text)
    private let detailLabel = CurtainView.label(size: 13, weight: .regular, color: Palette.text2)
    private let logLabel = CurtainView.label(size: 11, weight: .regular, color: Palette.text2)
    private let button = NSButton(title: "Restart", target: nil, action: nil)
    private let iris = IrisView()

    var onButton: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = Palette.obsidian.cgColor

        detailLabel.alignment = .center
        titleLabel.alignment = .center
        logLabel.alignment = .center
        logLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        logLabel.maximumNumberOfLines = 6

        button.bezelStyle = .rounded
        button.target = self
        button.action = #selector(buttonTapped)
        button.isHidden = true
        button.contentTintColor = Palette.ember

        let stack = NSStackView(views: [iris, titleLabel, detailLabel, logLabel, button])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -80),
            iris.widthAnchor.constraint(equalToConstant: 96),
            iris.heightAnchor.constraint(equalToConstant: 56),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func buttonTapped() { onButton?() }

    func show(title: String, detail: String, log: String = "", buttonTitle: String? = nil) {
        titleLabel.stringValue = title
        detailLabel.stringValue = detail
        logLabel.stringValue = log
        logLabel.isHidden = log.isEmpty
        if let buttonTitle {
            button.title = buttonTitle
            button.isHidden = false
        } else {
            button.isHidden = true
        }
        isHidden = false
    }

    private static func label(size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let field = NSTextField(labelWithString: "")
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 4
        return field
    }
}

/// A small ember eye, drawn so the waiting screen is recognisably Ground Control.
/// A container that accepts folders dragged in from Finder.
///
/// This is the one place in Ground Control where a drop is unambiguous: AppKit hands
/// over the real `file://` URLs, where a browser deliberately withholds them.
/// The paths go straight to the dashboard's own add-a-folder dialog.
final class DropHostView: NSView {

    /// Called on the main queue with the absolute paths of the dropped folders.
    var onFolders: (([String]) -> Void)?

    private let highlight = CALayer()
    private var isTargeted = false { didSet { needsDisplay = true } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerForDraggedTypes([.fileURL])
    }

    /// Directories only. A dragged file is not something Ground Control can watch, and
    /// refusing it during the drag is kinder than accepting and then erroring.
    private func folders(in sender: NSDraggingInfo) -> [String] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
        ]
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                               options: options) as? [URL] else { return [] }
        return urls.compactMap { url in
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue
            else { return nil }
            return url.path
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        isTargeted = !folders(in: sender).isEmpty
        return isTargeted ? .copy : []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        return isTargeted ? .copy : []
    }

    override func draggingExited(_ sender: NSDraggingInfo?) { isTargeted = false }
    override func draggingEnded(_ sender: NSDraggingInfo) { isTargeted = false }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        return !folders(in: sender).isEmpty
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let paths = folders(in: sender)
        isTargeted = false
        guard !paths.isEmpty else { return false }
        onFolders?(paths)
        return true
    }
}

final class IrisView: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 2, dy: 2)
        let almond = NSBezierPath()
        almond.move(to: NSPoint(x: r.minX, y: r.midY))
        almond.curve(to: NSPoint(x: r.maxX, y: r.midY),
                     controlPoint1: NSPoint(x: r.minX + r.width * 0.22, y: r.minY),
                     controlPoint2: NSPoint(x: r.maxX - r.width * 0.22, y: r.minY))
        almond.curve(to: NSPoint(x: r.minX, y: r.midY),
                     controlPoint1: NSPoint(x: r.maxX - r.width * 0.22, y: r.maxY),
                     controlPoint2: NSPoint(x: r.minX + r.width * 0.22, y: r.maxY))
        almond.close()
        NSGradient(starting: Palette.hex(0xfcd34d), ending: Palette.hex(0xc2620a))?
            .draw(in: almond, relativeCenterPosition: .zero)

        let slit = NSBezierPath()
        let cx = r.midX, top = r.midY - r.height * 0.34, bot = r.midY + r.height * 0.34
        slit.move(to: NSPoint(x: cx, y: top))
        slit.curve(to: NSPoint(x: cx, y: bot),
                   controlPoint1: NSPoint(x: cx + 9, y: top + r.height * 0.22),
                   controlPoint2: NSPoint(x: cx + 9, y: bot - r.height * 0.22))
        slit.curve(to: NSPoint(x: cx, y: top),
                   controlPoint1: NSPoint(x: cx - 9, y: bot - r.height * 0.22),
                   controlPoint2: NSPoint(x: cx - 9, y: top + r.height * 0.22))
        slit.close()
        Palette.obsidian.setFill()
        slit.fill()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - Application
// ═══════════════════════════════════════════════════════════════════════════

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    private var window: NSWindow!
    private var webView: WKWebView!
    private var curtain: CurtainView!
    private var server: ServerProcess?
    private var signalSources: [DispatchSourceSignal] = []

    private var isShuttingDown = false
    private var hasShownContent = false
    /// True while the curtain is showing an error. Guards the reveal paths, so
    /// a late timer can never pull the curtain off a failure and expose a
    /// broken web view underneath it.
    private var showingFailure = false
    private var bootGeneration = 0

    private let autosaveName = "GroundControlMainWindow"

    // ───────────────────────────────────────────────────────── lifecycle ──

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        installSignalHandlers()
        MenuBar.install(target: self)
        buildWindow()
        Payload.redirectForgeDirectory()
        boot()
    }

    func applicationWillTerminate(_ notification: Notification) {
        isShuttingDown = true
        server?.stop()
        server = nil
    }

    /// Closing the window is a quit: the contract wants the server gone in
    /// that case too, and a Ground Control with no window has nothing left to do.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Clicking the Dock icon when the window was closed is not reachable
    /// (closing quits), but re-activating should still surface the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag, window != nil, hasShownContent { window.makeKeyAndOrderFront(nil) }
        return true
    }

    /// SIGTERM from Activity Monitor, or SIGINT when run from a terminal.
    /// SIGKILL cannot be handled: the shell watchdog covers that case.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                self?.isShuttingDown = true
                self?.server?.stop()
                exit(0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    // ───────────────────────────────────────────────────────────── window ──

    private func buildWindow() {
        let content = NSRect(x: 0, y: 0, width: 1280, height: 860)
        window = NSWindow(contentRect: content,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered,
                          defer: false)
        window.title = "Ground Control"
        window.minSize = NSSize(width: 720, height: 520)
        window.backgroundColor = Palette.obsidian
        window.titlebarAppearsTransparent = true          // §4: hidden title bar
        window.titleVisibility = .hidden
        window.appearance = NSAppearance(named: .darkAqua)
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false

        // The whole content area accepts a folder dragged in from Finder. AppKit
        // gives us the real path; the browser never would.
        let root = DropHostView(frame: content)
        root.wantsLayer = true
        root.layer?.backgroundColor = Palette.obsidian.cgColor
        root.onFolders = { [weak self] paths in self?.offerFolders(paths) }
        window.contentView = root

        // Web view ─────────────────────────────────────────────────────────
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.suppressesIncrementalRendering = true      // no half-painted first frame
        // The dashboard asks for the system folder chooser through this; inside
        // the app an NSOpenPanel is a real, frontmost, focus-correct sheet,
        // where the server's osascript fallback is a dialog from another process.
        config.userContentController.add(self, name: "gcPickFolder")

        webView = WKWebView(frame: root.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.wantsLayer = true
        webView.layer?.backgroundColor = Palette.obsidian.cgColor
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) { webView.underPageBackgroundColor = Palette.obsidian }
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.isHidden = true
        root.addSubview(webView)

        // Curtain ──────────────────────────────────────────────────────────
        curtain = CurtainView(frame: root.bounds)
        curtain.autoresizingMask = [.width, .height]
        curtain.onButton = { [weak self] in self?.restartServer() }
        root.addSubview(curtain)

        // Frame restoration (§4). setFrameUsingName first, autosave after, so
        // a first run centres and every later run reopens where it was.
        if !window.setFrameUsingName(autosaveName) {
            window.setContentSize(NSSize(width: 1280, height: 860))
            window.center()
        }
        window.setFrameAutosaveName(autosaveName)
    }

    // ─────────────────────────────────────────────────────────────── boot ──

    private func boot() {
        bootGeneration += 1
        let generation = bootGeneration
        showingFailure = false
        curtain.show(title: "Ground Control", detail: "Starting the server…")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }

            guard Payload.isPresent else {
                DispatchQueue.main.async {
                    self.fail(title: "Ground Control is incomplete",
                              detail: "server.js and public/ were not found in \(Payload.directory.path). Rebuild the app with ./build-app.sh.")
                }
                return
            }

            guard let node = NodeFinder.find() else {
                DispatchQueue.main.async { self.reportMissingNode() }
                return
            }

            guard let port = FreePort.claim() else {
                DispatchQueue.main.async {
                    self.fail(title: "No free port",
                              detail: "The system would not hand out a local port for the server.")
                }
                return
            }

            let process = ServerProcess(nodePath: node, port: port,
                                        scanRoot: Payload.scanRoot, logURL: Payload.logFile)
            process.onUnexpectedExit = { [weak self] reason in
                self?.serverDied(reason: reason, generation: generation)
            }

            do { try process.start() }
            catch {
                DispatchQueue.main.async {
                    self.fail(title: "The server would not start",
                              detail: error.localizedDescription)
                }
                return
            }

            DispatchQueue.main.async {
                guard generation == self.bootGeneration else { process.stop(); return }
                self.server = process
            }

            let ready = Readiness.wait(port: port, timeout: 10) { process.isRunning }

            DispatchQueue.main.async {
                guard generation == self.bootGeneration else { return }
                guard ready else {
                    process.stop()
                    self.fail(title: "The server did not come up",
                              detail: "Node started but /api/projects never answered within 10 seconds.",
                              log: process.logTail())
                    return
                }
                self.loadDashboard(port: port)
            }
        }
    }

    private func loadDashboard(port: UInt16) {
        curtain.show(title: "Ground Control", detail: "Loading the dashboard…")
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))

        // If didFinish never lands, do not leave the user staring at a curtain.
        let generation = bootGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, generation == self.bootGeneration else { return }
            self.revealContent()
        }
    }

    /// Only now does the window reach the screen: obsidian all the way, with
    /// no white frame and no "could not connect" page in between (§3.3, §4).
    private func revealContent() {
        guard !hasShownContent, !showingFailure else { return }
        hasShownContent = true
        webView.isHidden = false
        curtain.isHidden = true
        if !window.isVisible {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        window.makeFirstResponder(webView)
    }

    private func showWindowForMessage() {
        if !window.isVisible {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // ──────────────────────────────────────────────────────────── failure ──

    private func fail(title: String, detail: String, log: String = "") {
        showingFailure = true
        webView.isHidden = true
        curtain.show(title: title, detail: detail, log: log, buttonTitle: "Try Again")
        showWindowForMessage()
    }

    private func serverDied(reason: String, generation: Int) {
        guard !isShuttingDown, generation == bootGeneration else { return }
        showingFailure = true
        let log = server?.logTail() ?? ""
        webView.isHidden = true
        curtain.show(title: "The server stopped",
                     detail: "Ground Control's Node process stopped (\(reason)). The dashboard cannot update until it is back.",
                     log: log,
                     buttonTitle: "Restart Server")
        showWindowForMessage()
    }

    private func restartServer() {
        server?.stop()
        server = nil
        hasShownContent = false
        webView.isHidden = true
        webView.load(URLRequest(url: URL(string: "about:blank")!))
        boot()
    }

    private func reportMissingNode() {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Node.js was not found"
        alert.informativeText = """
        Ground Control runs a small Node server behind its window, and no `node` \
        executable could be found.

        Looked in /opt/homebrew/bin, /usr/local/bin and /usr/bin, and asked \
        your login shell.

        Install it with Homebrew:

            brew install node

        or download it from nodejs.org, then open Ground Control again.
        """
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Open nodejs.org")
        showWindowForMessage()
        curtain.show(title: "Node.js was not found",
                     detail: "Install Node (brew install node) and open Ground Control again.",
                     buttonTitle: "Try Again")
        webView.isHidden = true
        if alert.runModal() == .alertSecondButtonReturn {
            NSWorkspace.shared.open(URL(string: "https://nodejs.org/")!)
        } else {
            NSApp.terminate(nil)
        }
    }

    // ────────────────────────────────────────────────────── menu actions ──

    @objc func rescan(_ sender: Any?) {
        // The dashboard's own rescan button hits /api/projects?fresh=1 and
        // keeps the current view; that is nicer than a reload.
        webView.evaluateJavaScript("(function(){var b=document.getElementById('rescan');if(b){b.click();return true}return false})()") { [weak self] result, _ in
            if (result as? Bool) != true { self?.webView.reloadFromOrigin() }
        }
    }

    @objc func reloadPage(_ sender: Any?) { webView.reloadFromOrigin() }

    // ─────────────────────────────────────────────────────── adding folders ──

    /// File ▸ Add Folder…: the same NSOpenPanel the dashboard's "Choose…"
    /// button reaches through the script bridge.
    @objc func addFolder(_ sender: Any?) {
        chooseFolder { [weak self] path in
            guard let self, let path else { return }
            self.offerFolders([path])
        }
    }

    /// One folder, chosen with a real system panel. `nil` means cancelled.
    private func chooseFolder(_ done: @escaping (String?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Choose"
        panel.message = "Choose a folder for Ground Control to watch."
        NSApp.activate(ignoringOtherApps: true)
        if let window, window.isVisible {
            panel.beginSheetModal(for: window) { response in
                done(response == .OK ? panel.url?.path : nil)
            }
        } else {
            done(panel.runModal() == .OK ? panel.url?.path : nil)
        }
    }

    /// Hand paths to the dashboard, which confirms them in its own dialog.
    /// Nothing is added here: the app shell never writes to the source list.
    private func offerFolders(_ paths: [String]) {
        guard hasShownContent, !paths.isEmpty else { return }
        guard let json = try? JSONSerialization.data(withJSONObject: paths),
              let arg = String(data: json, encoding: .utf8) else { return }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript(
            "(window.groundControlAddFolders && window.groundControlAddFolders(\(arg))) === true") { _, _ in }
    }

    /// `window.webkit.messageHandlers.gcPickFolder.postMessage(...)`
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "gcPickFolder" else { return }
        chooseFolder { [weak self] path in
            guard let self else { return }
            // JSONSerialization refuses a bare string, so the path travels as a
            // one-element array and the page reads element zero.
            var arg = "null"
            if let path,
               let data = try? JSONSerialization.data(withJSONObject: [path]),
               let array = String(data: data, encoding: .utf8) {
                arg = "\(array)[0]"
            }
            self.webView.evaluateJavaScript(
                "window.groundControlPickedFolder && window.groundControlPickedFolder(\(arg))") { _, _ in }
        }
    }

    @objc func actualSize(_ sender: Any?) { webView.pageZoom = 1.0 }
    @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom * 1.1, 3.0) }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom / 1.1, 0.5) }

    @objc func showServerLog(_ sender: Any?) {
        NSWorkspace.shared.selectFile(Payload.logFile.path,
                                      inFileViewerRootedAtPath: Payload.logFile.deletingLastPathComponent().path)
    }

    // ─────────────────────────────────────────────── navigation policing ──

    private func isLocalDashboard(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "about" || scheme == "blob" || scheme == "data" { return true }
        guard scheme == "http", let port = server?.port else { return false }
        let host = (url.host ?? "").lowercased()
        guard ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host) else { return false }
        return url.port == Int(port)
    }

    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased() else { return }
        // Only hand the workspace things it should be handing to a browser or
        // a mail client: never a file:// path the page talked us into.
        guard ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if isLocalDashboard(url) { decisionHandler(.allow); return }
        openExternally(url)
        decisionHandler(.cancel)
    }

    /// Anything the app cannot render itself (a download, a PDF, a zip)
    /// belongs to the browser, not to a blank window here (§5).
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            if let url = navigationResponse.response.url { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    /// `target="_blank"` and `window.open`. Returning nil with no side effect
    /// would swallow the click; returning a real web view would open a second,
    /// chrome-less window. Both are wrong: send it to the browser (§5).
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.absoluteString != "about:blank" else { return }
        revealContent()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    private func handleLoadFailure(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        guard !isShuttingDown else { return }
        fail(title: "The dashboard would not load",
             detail: error.localizedDescription,
             log: server?.logTail() ?? "")
        hasShownContent = false
    }

    // JavaScript dialogs. The dashboard uses its own in-page dialogs, but a
    // WKWebView with no UI delegate for these silently drops them.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Ground Control"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Ground Control"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Ground Control"
        alert.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) {
            completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - Menu bar
// ═══════════════════════════════════════════════════════════════════════════

enum MenuBar {

    /// Note what is *not* here: nothing binds ⌘K. The dashboard's quick
    /// switcher owns that key, and a menu item would eat the event before the
    /// web view ever saw it (§4).
    static func install(target: AppDelegate) {
        let main = NSMenu()

        // ── Ground Control ────────────────────────────────────────────────────────
        let app = NSMenu()
        app.addItem(item("About Ground Control", "orderFrontStandardAboutPanel:"))
        app.addItem(.separator())
        app.addItem(item("Hide Ground Control", "hide:", "h"))
        app.addItem(item("Hide Others", "hideOtherApplications:", "h", [.command, .option]))
        app.addItem(item("Show All", "unhideAllApplications:"))
        app.addItem(.separator())
        app.addItem(item("Quit Ground Control", "terminate:", "q"))
        main.addItem(submenu("Ground Control", app))

        // ── File ──────────────────────────────────────────────────────────
        let file = NSMenu(title: "File")
        file.addItem(action("Add Folder…", #selector(AppDelegate.addFolder(_:)), "o", [.command, .shift], target: target))
        file.addItem(.separator())
        file.addItem(action("Rescan Projects", #selector(AppDelegate.rescan(_:)), "r", target: target))
        file.addItem(.separator())
        file.addItem(action("Open Server Log…", #selector(AppDelegate.showServerLog(_:)), "l", target: target))
        file.addItem(.separator())
        file.addItem(item("Close Window", "performClose:", "w"))
        main.addItem(submenu("File", file))

        // ── Edit ──────────────────────────────────────────────────────────
        // Without these, ⌘C and ⌘V do nothing in the filter field and in the
        // Reclaim confirmation input. They go to the first responder, which is
        // the web view (§4).
        let edit = NSMenu(title: "Edit")
        edit.addItem(item("Undo", "undo:", "z"))
        edit.addItem(item("Redo", "redo:", "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(item("Cut", "cut:", "x"))
        edit.addItem(item("Copy", "copy:", "c"))
        edit.addItem(item("Paste", "paste:", "v"))
        edit.addItem(item("Paste and Match Style", "pasteAsPlainText:", "v", [.command, .option, .shift]))
        edit.addItem(item("Delete", "delete:"))
        edit.addItem(item("Select All", "selectAll:", "a"))
        main.addItem(submenu("Edit", edit))

        // ── View ──────────────────────────────────────────────────────────
        let view = NSMenu(title: "View")
        view.addItem(action("Reload", #selector(AppDelegate.reloadPage(_:)), "r", [.command, .shift], target: target))
        view.addItem(.separator())
        view.addItem(action("Actual Size", #selector(AppDelegate.actualSize(_:)), "0", target: target))
        view.addItem(action("Zoom In", #selector(AppDelegate.zoomIn(_:)), "+", target: target))
        view.addItem(action("Zoom Out", #selector(AppDelegate.zoomOut(_:)), "-", target: target))
        view.addItem(.separator())
        view.addItem(item("Enter Full Screen", "toggleFullScreen:", "f", [.command, .control]))
        main.addItem(submenu("View", view))

        // ── Window ────────────────────────────────────────────────────────
        let window = NSMenu(title: "Window")
        window.addItem(item("Minimize", "performMiniaturize:", "m"))
        window.addItem(item("Zoom", "performZoom:"))
        window.addItem(.separator())
        window.addItem(item("Bring All to Front", "arrangeInFront:"))
        let windowMenuItem = submenu("Window", window)
        main.addItem(windowMenuItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = window
    }

    // ── construction helpers ──────────────────────────────────────────────

    private static func submenu(_ title: String, _ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        menu.title = title
        return item
    }

    /// Responder-chain item: `target` stays nil so AppKit routes it to the
    /// first responder (the web view), which is exactly what Edit needs.
    private static func item(_ title: String, _ selector: String, _ key: String = "",
                             _ mask: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        if !key.isEmpty { item.keyEquivalentModifierMask = mask }
        return item
    }

    private static func action(_ title: String, _ selector: Selector, _ key: String,
                               _ mask: NSEvent.ModifierFlags = .command,
                               target: AnyObject) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.keyEquivalentModifierMask = mask
        item.target = target
        return item
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARK: - main
// ═══════════════════════════════════════════════════════════════════════════

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
