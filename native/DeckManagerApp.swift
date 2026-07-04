// DeckManagerApp — native macOS shell for Deck Manager.
//
// Starts the Node server (deck-manager/server.mjs) in the chosen workshop
// folder, shows the library in a WKWebView, and — crucially — makes the
// embedded web UI behave like a browser: window.open() opens a real native
// window (individually shareable in Zoom/Meet) and PDF links download to
// ~/Downloads. Without the WKUIDelegate / download plumbing below, WKWebView
// silently drops both, which is why the Slideshow/Present/PDF buttons did
// nothing.
//
// Built + Developer-ID-signed via build.sh (no Xcode project).

import SwiftUI
import WebKit
import AppKit

let SERVER_PORT = 4321
let SERVER_ORIGIN = "http://127.0.0.1:\(SERVER_PORT)"

// MARK: - Server process manager

final class Server: ObservableObject {
    static let shared = Server()
    private var process: Process?          // only set if WE spawned it
    @Published var ready = false
    @Published var status = "Starting…"

    /// The workshop folder that holds the decks — decoupled from the tool. It's
    /// the saved choice (File ▸ Open Workshop Folder…), else the path baked into
    /// Info.plist at build time, else ~/Desktop.
    static var workshopFolder: String {
        get {
            var dir: ObjCBool = false
            if let s = UserDefaults.standard.string(forKey: "workshopFolder"),
               FileManager.default.fileExists(atPath: s, isDirectory: &dir), dir.boolValue {
                return s
            }
            return defaultFolder
        }
        set { UserDefaults.standard.set(newValue, forKey: "workshopFolder") }
    }

    static var defaultFolder: String {
        var dir: ObjCBool = false
        if let baked = Bundle.main.object(forInfoDictionaryKey: "WorkshopFolder") as? String,
           FileManager.default.fileExists(atPath: baked, isDirectory: &dir), dir.boolValue {
            return baked
        }
        return NSHomeDirectory() + "/Desktop"
    }

    /// The tool's server.mjs — lives next to the app bundle inside the tool
    /// folder (…/deck-manager/native/DeckManager.app → …/deck-manager/server.mjs),
    /// independent of where the decks are.
    static var serverScript: String {
        let bundled = URL(fileURLWithPath: Bundle.main.bundlePath)
            .deletingLastPathComponent()   // native/
            .deletingLastPathComponent()   // deck-manager/ (tool root)
            .appendingPathComponent("server.mjs").path
        if FileManager.default.fileExists(atPath: bundled) { return bundled }
        // Dev fallback: running unbundled from the tool folder.
        let cwd = FileManager.default.currentDirectoryPath
        for c in ["\(cwd)/server.mjs", "\(cwd)/deck-manager/server.mjs"] where
            FileManager.default.fileExists(atPath: c) { return c }
        return bundled
    }

    private func findNode() -> String? {
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v node"]
        let pipe = Pipe(); p.standardOutput = pipe
        try? p.run(); p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (out?.isEmpty == false) ? out : nil
    }

    func start() {
        // Reuse a server that's already up (dev preview, the .command launcher,
        // or a prior run) rather than fighting over the port.
        probe { alreadyUp in
            if alreadyUp { self.ready = true; self.status = "Ready"; return }
            self.spawn()
        }
    }

    private func spawn() {
        let folder = Server.workshopFolder
        guard let node = findNode() else {
            status = "Node.js not found. Install from nodejs.org, then reopen."; return
        }
        let script = Server.serverScript
        guard FileManager.default.fileExists(atPath: script) else {
            status = "server.mjs not found next to the app. Rebuild with build.sh."; return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script]
        p.currentDirectoryURL = URL(fileURLWithPath: folder)
        var env = ProcessInfo.processInfo.environment
        env["DECK_MANAGER_PORT"] = String(SERVER_PORT)
        env["DECK_MANAGER_ROOT"] = folder      // decks live here, not next to the tool
        p.environment = env
        do { try p.run() } catch { status = "Could not start server: \(error.localizedDescription)"; return }
        process = p
        waitForReady()
    }

    private func probe(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: SERVER_ORIGIN + "/api/decks")!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async { done((resp as? HTTPURLResponse)?.statusCode == 200) }
        }.resume()
    }

    private func waitForReady(attempt: Int = 0) {
        guard attempt < 50 else { status = "Server did not respond on port \(SERVER_PORT)."; return }
        probe { up in
            if up { self.ready = true; self.status = "Ready" }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitForReady(attempt: attempt + 1) } }
        }
    }

    func restart() { stop(); ready = false; status = "Restarting…"; start() }
    /// Only stop the child WE spawned — never a server someone else is using.
    func stop() { process?.terminate(); process = nil }
}

// MARK: - Native window retention

/// Holds strong references to each auxiliary window AND its WebView coordinator
/// (WKWebView.uiDelegate/navigationDelegate are weak, so an un-retained
/// coordinator would deallocate immediately and break window.open/downloads);
/// drops both on close.
final class WindowStore: NSObject, NSWindowDelegate {
    static let shared = WindowStore()
    private var entries: [(win: NSWindow, coord: WebView.Coordinator)] = []

    func adopt(_ win: NSWindow, _ coord: WebView.Coordinator) {
        win.isReleasedWhenClosed = false
        win.delegate = self
        entries.append((win, coord))
    }
    func windowWillClose(_ notification: Notification) {
        guard let w = notification.object as? NSWindow else { return }
        entries.removeAll { $0.win === w }
    }
}

// MARK: - Browser-parity WebView

/// A WKWebView whose coordinator turns window.open() into native windows and
/// routes downloads (PDF export) to ~/Downloads. Reused for every window.
struct WebView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let wv = WebFactory.make(coordinator: context.coordinator)
        wv.load(URLRequest(url: url))
        return wv
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {

        // window.open(url, target) → native window (or a download for PDF).
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = navigationAction.request.url else { return nil }
            if url.path == "/api/pdf" {           // a "download", not a window
                webView.load(URLRequest(url: url)) // triggers navigationResponse → .download
                return nil
            }
            // Fresh coordinator per window, retained by WindowStore so it (and
            // thus the weak uiDelegate/navigationDelegate link) stays alive.
            let childCoord = Coordinator()
            let child = WebFactory.make(coordinator: childCoord, configuration: configuration)
            let vc = NSViewController()
            vc.view = child
            let win = NSWindow(contentViewController: vc)
            win.title = Self.titleFor(url)
            win.setContentSize(NSSize(width: 1280, height: 720))
            win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            win.center()
            WindowStore.shared.adopt(win, childCoord)
            win.makeKeyAndOrderFront(nil)
            return child                           // WebKit loads the URL into it
        }

        // Attachment / PDF responses become downloads.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            let resp = navigationResponse.response
            let isPdf = (resp.mimeType == "application/pdf")
            var isAttachment = false
            if let http = resp as? HTTPURLResponse,
               let disp = http.value(forHTTPHeaderField: "Content-Disposition") {
                isAttachment = disp.lowercased().contains("attachment")
            }
            decisionHandler((isPdf || isAttachment) ? .download : .allow)
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                     didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                     didBecome download: WKDownload) { download.delegate = self }

        // Save to ~/Downloads (uniquified) and reveal in Finder.
        func download(_ download: WKDownload,
                      decideDestinationUsing response: URLResponse,
                      suggestedFilename: String,
                      completionHandler: @escaping (URL?) -> Void) {
            let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory() + "/Downloads")
            var dest = dir.appendingPathComponent(suggestedFilename.isEmpty ? "deck.pdf" : suggestedFilename)
            let base = dest.deletingPathExtension().lastPathComponent
            let ext = dest.pathExtension
            var n = 1
            while FileManager.default.fileExists(atPath: dest.path) {
                dest = dir.appendingPathComponent("\(base) \(n).\(ext)"); n += 1
            }
            lastDest = dest
            completionHandler(dest)
        }
        func downloadDidFinish(_ download: WKDownload) {
            if let url = lastDest { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        }
        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            NSSound.beep()
        }
        private var lastDest: URL?

        static func titleFor(_ url: URL) -> String {
            let deck = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "deck" })?.value
            let name = (deck ?? url.deletingPathExtension().lastPathComponent) as NSString
            if url.query?.contains("_dmshow") == true { return "Slideshow — " + name.lastPathComponent }
            if url.path.contains("presenter.html") { return "Presenter — " + name.lastPathComponent }
            return name.lastPathComponent
        }
    }
}

enum WebFactory {
    static func make(coordinator: WebView.Coordinator,
                     configuration: WKWebViewConfiguration? = nil) -> WKWebView {
        let cfg = configuration ?? WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.uiDelegate = coordinator
        wv.navigationDelegate = coordinator
        wv.allowsMagnification = true
        return wv
    }
}

// MARK: - App

@main
struct DeckManagerApp: App {
    @StateObject private var server = Server.shared
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup("Deck Manager") {
            RootView().environmentObject(server).frame(minWidth: 900, minHeight: 600)
        }
        .commands { DeckCommands() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) { Server.shared.start() }
    func applicationWillTerminate(_ notification: Notification) { Server.shared.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct RootView: View {
    @EnvironmentObject var server: Server
    var body: some View {
        Group {
            if server.ready {
                WebView(url: URL(string: SERVER_ORIGIN + "/")!)
            } else {
                VStack(spacing: 14) {
                    ProgressView()
                    Text(server.status).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(red: 0.04, green: 0.055, blue: 0.10))
            }
        }
    }
}

// MARK: - Menu commands (open the same native windows as window.open)

struct DeckCommands: Commands {
    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Open Workshop Folder…") { chooseFolder() }.keyboardShortcut("o")
            Divider()
            Button("Export Current Deck as PDF…") { forFirstDeck { open("/api/pdf?path=" + q($0)) } }
                .keyboardShortcut("e")
        }
        CommandMenu("Play") {
            Button("Play Slideshow") { forFirstDeck { openWindow("/files/" + esc($0) + "?_dmshow=1#1") } }
                .keyboardShortcut("l")
            Button("Presenter View") { forFirstDeck { openWindow("/__dm/presenter.html?deck=" + q($0)) } }
                .keyboardShortcut("p")
        }
    }

    private func esc(_ s: String) -> String {
        s.split(separator: "/").map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }.joined(separator: "/")
    }
    private func q(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s }

    /// Open a native window on a server path (reuses the browser-parity WebView).
    private func openWindow(_ path: String) {
        guard let url = URL(string: SERVER_ORIGIN + path) else { return }
        let coord = WebView.Coordinator()
        let web = WebFactory.make(coordinator: coord)
        web.load(URLRequest(url: url))
        let vc = NSViewController()
        vc.view = web
        let win = NSWindow(contentViewController: vc)
        win.title = WebView.Coordinator.titleFor(url)
        win.setContentSize(NSSize(width: 1280, height: 760))
        win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        win.center()
        WindowStore.shared.adopt(win, coord)   // retains the coordinator too
        win.makeKeyAndOrderFront(nil)
    }
    private func open(_ path: String) { NSWorkspace.shared.open(URL(string: SERVER_ORIGIN + path)!) }

    private func forFirstDeck(_ use: @escaping (String) -> Void) {
        var req = URLRequest(url: URL(string: SERVER_ORIGIN + "/api/decks")!)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var path: String?
            if let data, let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                path = arr.first(where: { ($0["bundled"] as? Bool) == false })?["path"] as? String
            }
            if let path { DispatchQueue.main.async { use(path) } }
        }.resume()
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Use Folder"
        if panel.runModal() == .OK, let url = panel.url {
            Server.workshopFolder = url.path
            Server.shared.restart()
        }
    }
}
