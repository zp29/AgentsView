import Foundation
import Network

/// Minimal loopback HTTP server for agent hooks and health checks.
final class LocalHub: @unchecked Sendable {
    private let port: UInt16
    private let secret: String
    private let store: TaskStore
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.agentsview.bar.hub", qos: .userInitiated)
    private var onState: ((Result<Void, Error>) -> Void)?

    init(port: UInt16, secret: String, store: TaskStore) {
        self.port = port
        self.secret = secret
        self.store = store
    }

    /// Starts listening on 127.0.0.1 only. Calls `onState` on the hub queue when ready or failed.
    func start(onState: @escaping (Result<Void, Error>) -> Void) throws {
        self.onState = onState

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.acceptLocalOnly = true

        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw HubError.badRequest("Invalid hub port: \(port)")
        }

        let listener = try NWListener(using: parameters, on: nwPort)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                NSLog("[AgentsBar] hub ready on 127.0.0.1:%u", self.port)
                self.onState?(.success(()))
            case .failed(let error):
                NSLog("[AgentsBar] hub listener failed: \(error)")
                self.onState?(.failure(error))
            case .cancelled:
                NSLog("[AgentsBar] hub listener cancelled")
            default:
                break
            }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
        onState = nil
    }

    private func handle(_ connection: NWConnection) {
        // Defense in depth: only serve loopback peers.
        if let path = connection.currentPath,
           let endpoint = path.remoteEndpoint,
           !isLoopback(endpoint) {
            connection.cancel()
            return
        }
        connection.start(queue: queue)
        receiveHeader(connection: connection, buffer: Data())
    }

    private func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        switch endpoint {
        case .hostPort(let host, _):
            switch host {
            case .ipv4(let addr):
                return addr == .loopback
            case .ipv6(let addr):
                return addr == .loopback
            case .name(let name, _):
                return name == "localhost" || name == "127.0.0.1" || name == "::1"
            @unknown default:
                return false
            }
        default:
            // Local connections sometimes omit a remote endpoint early.
            return true
        }
    }

    private func receiveHeader(connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error {
                NSLog("[AgentsBar] hub read error: \(error)")
                connection.cancel()
                return
            }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                let bodySoFar = buffer.subdata(in: range.upperBound..<buffer.endIndex)
                guard let headerText = String(data: headerData, encoding: .utf8) else {
                    self.respond(connection, status: 400, body: #"{"error":"bad request"}"#)
                    return
                }
                let lines = headerText.split(separator: "\r\n", omittingEmptySubsequences: false).map(String.init)
                guard let requestLine = lines.first else {
                    self.respond(connection, status: 400, body: #"{"error":"bad request"}"#)
                    return
                }
                let parts = requestLine.split(separator: " ")
                guard parts.count >= 2 else {
                    self.respond(connection, status: 400, body: #"{"error":"bad request"}"#)
                    return
                }
                let method = String(parts[0])
                let path = String(parts[1])
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    if let idx = line.firstIndex(of: ":") {
                        let key = line[..<idx].trimmingCharacters(in: .whitespaces).lowercased()
                        let value = line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
                        headers[key] = value
                    }
                }
                let contentLength = Int(headers["content-length"] ?? "0") ?? 0
                if contentLength > 256 * 1024 {
                    self.respond(connection, status: 413, body: #"{"error":"body too large"}"#)
                    return
                }
                self.receiveBody(
                    connection: connection,
                    method: method,
                    path: path,
                    headers: headers,
                    body: bodySoFar,
                    remaining: max(0, contentLength - bodySoFar.count)
                )
                return
            }
            if isComplete || buffer.count > 1024 * 1024 {
                self.respond(connection, status: 400, body: #"{"error":"bad request"}"#)
                return
            }
            self.receiveHeader(connection: connection, buffer: buffer)
        }
    }

    private func receiveBody(
        connection: NWConnection,
        method: String,
        path: String,
        headers: [String: String],
        body: Data,
        remaining: Int
    ) {
        if remaining <= 0 {
            dispatch(connection: connection, method: method, path: path, headers: headers, body: body)
            return
        }
        connection.receive(minimumIncompleteLength: 1, maximumLength: remaining) { [weak self] data, _, _, error in
            guard let self else { return }
            if let error {
                NSLog("[AgentsBar] hub body error: \(error)")
                connection.cancel()
                return
            }
            var body = body
            if let data { body.append(data) }
            let left = remaining - (data?.count ?? 0)
            if left <= 0 {
                self.dispatch(connection: connection, method: method, path: path, headers: headers, body: body)
            } else {
                self.receiveBody(connection: connection, method: method, path: path, headers: headers, body: body, remaining: left)
            }
        }
    }

    private func dispatch(connection: NWConnection, method: String, path: String, headers: [String: String], body: Data) {
        do {
            if method == "GET" && (path == "/health" || path.hasPrefix("/health?")) {
                respond(connection, status: 200, body: #"{"ok":true,"service":"AgentsBar"}"#)
                return
            }
            if method == "POST", path == "/hooks/claude" || path == "/hooks/codex" {
                try authorize(headers: headers)
                let provider: AgentKind = path.hasSuffix("codex") ? .codex : .claude
                let object = try JSONSerialization.jsonObject(with: body.isEmpty ? Data("{}".utf8) : body)
                guard let payload = object as? [String: Any] else {
                    throw HubError.badRequest("JSON object required")
                }
                let result = try store.handleHook(provider: provider, payload: payload)
                let data = try JSONSerialization.data(withJSONObject: result)
                let text = String(data: data, encoding: .utf8) ?? "{}"
                respond(connection, status: 200, body: text)
                return
            }
            respond(connection, status: 404, body: #"{"error":"not found"}"#)
        } catch let error as HubError {
            let message = error.localizedDescription.replacingOccurrences(of: "\"", with: "'")
            respond(connection, status: error.statusCode, body: "{\"error\":\"\(message)\"}")
        } catch {
            let message = error.localizedDescription.replacingOccurrences(of: "\"", with: "'")
            respond(connection, status: 500, body: "{\"error\":\"\(message)\"}")
        }
    }

    private func authorize(headers: [String: String]) throws {
        let provided = headers["x-agentsbar-hook-secret"]
            ?? headers["x-agentsview-hook-secret"]
            ?? bearer(headers["authorization"])
            ?? ""
        guard provided == secret, !secret.isEmpty else {
            throw HubError.unauthorized
        }
    }

    private func bearer(_ value: String?) -> String? {
        guard let value, value.lowercased().hasPrefix("bearer ") else { return nil }
        return String(value.dropFirst(7)).trimmingCharacters(in: .whitespaces)
    }

    private func respond(_ connection: NWConnection, status: Int, body: String) {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 400: reason = "Bad Request"
        case 401: reason = "Unauthorized"
        case 404: reason = "Not Found"
        case 413: reason = "Payload Too Large"
        default: reason = "Error"
        }
        let payload = Data(body.utf8)
        var response = "HTTP/1.1 \(status) \(reason)\r\n"
        response += "Content-Type: application/json; charset=utf-8\r\n"
        response += "Content-Length: \(payload.count)\r\n"
        response += "Connection: close\r\n"
        response += "\r\n"
        var data = Data(response.utf8)
        data.append(payload)
        connection.send(content: data, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
