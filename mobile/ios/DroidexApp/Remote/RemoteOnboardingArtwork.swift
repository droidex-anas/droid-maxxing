import SwiftUI
import WebKit

/// This explains pairing. It is deliberately separate from live connection status.
struct RemoteOnboardingArtwork: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var loadFailed = false
    var step: Int? = nil

    private var bannerURL: URL? {
        Bundle.main.url(forResource: "banner", withExtension: "html", subdirectory: "RemoteArtwork")
    }

    private var guideURL: URL? {
        Bundle.main.url(forResource: "guide", withExtension: "svg", subdirectory: "RemoteArtwork")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let bannerURL, !loadFailed {
                ArtworkWebView(
                    url: bannerURL,
                    active: visible && scenePhase == .active,
                    reducedMotion: reduceMotion,
                    step: step,
                    onFailure: { loadFailed = true }
                )
                .frame(height: 208)
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(DroidTheme.separator))
                .accessibilityIdentifier("remote.artwork")
            } else {
                Text("Open Remote on your computer, pair your phone, then approve the connection on your computer.")
                    .font(.subheadline)
                    .foregroundStyle(DroidTheme.secondary)
            }
            if let guideURL {
                ShareLink(item: guideURL) {
                    Text("Share pairing guide")
                        .font(.footnote.weight(.medium))
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("remote.share-guide")
            }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
    }
}

private struct ArtworkWebView: UIViewRepresentable {
    let url: URL
    let active: Bool
    let reducedMotion: Bool
    let step: Int?
    let onFailure: @MainActor () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(url: url, onFailure: onFailure) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 9 / 255, green: 11 / 255, blue: 15 / 255, alpha: 1)
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.navigationDelegate = context.coordinator
        context.coordinator.configure(active: active, reducedMotion: reducedMotion, step: step)
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.configure(active: active, reducedMotion: reducedMotion, step: step)
        context.coordinator.updatePlayback(in: view)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.configure(active: false, reducedMotion: true, step: nil)
        coordinator.updatePlayback(in: view)
        view.stopLoading()
        view.navigationDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private let url: URL
        private let onFailure: @MainActor () -> Void
        private var ready = false
        private var active = false
        private var reducedMotion = false
        private var step: Int?
        private var lastScript: String?

        init(url: URL, onFailure: @escaping @MainActor () -> Void) {
            self.url = url
            self.onFailure = onFailure
        }

        func configure(active: Bool, reducedMotion: Bool, step: Int?) {
            self.active = active
            self.reducedMotion = reducedMotion
            self.step = step.flatMap { (0...3).contains($0) ? $0 : nil }
        }

        func updatePlayback(in view: WKWebView) {
            guard ready else { return }
            // Only bounded literals reach the isolated artwork, never provider text or credentials.
            let index = step.map { String($0) } ?? "null"
            let script = "window.DroidexRemoteArtwork.configure({active:\(active),reducedMotion:\(reducedMotion),step:\(index)})"
            guard script != lastScript else { return }
            lastScript = script
            view.evaluateJavaScript(script) { [weak self] _, error in
                if error != nil { self?.onFailure() }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ready = true
            lastScript = nil
            updatePlayback(in: webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { onFailure() }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { onFailure() }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let allowed = action.request.url?.standardizedFileURL == url.standardizedFileURL
            decisionHandler(allowed ? .allow : .cancel)
        }
    }
}
