'use strict';

/**
 * Loopback relay for proxies that require authentication.
 *
 * Chromium's network stack accepts proxy rules but, for requests made through
 * `session.fetch`, never emits the login event on a 407 and rejects embedded
 * credentials (`ERR_NO_SUPPORTED_PROXIES`). So when the user fills in a proxy
 * username we point Chromium at this tiny local relay instead; it adds
 * `Proxy-Authorization` upstream and forwards both plain requests and CONNECT
 * tunnels. The relay listens on 127.0.0.1 with a random port and only speaks
 * to the configured upstream proxy.
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const MAX_HEAD = 64 * 1024;
const CONNECT_TIMEOUT = 20000;

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

class AuthRelay {
  constructor({ scheme, host, port, username, password }) {
    this.scheme = scheme === 'https' ? 'https' : 'http';
    this.host = host;
    this.port = port;
    this.authorization = basicAuth(username, password);
    this.server = null;
    this.port_ = 0;
  }

  get listeningPort() {
    return this.port_;
  }

  async start() {
    if (this.server && this.port_) return this.port_;
    const server = http.createServer((req, res) => this.#forward(req, res));
    server.on('connect', (req, socket, head) => this.#tunnel(req, socket, head));
    server.on('clientError', (_error, socket) => {
      try {
        socket.destroy();
      } catch {
        /* gone */
      }
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    this.server = server;
    this.port_ = server.address().port;
    return this.port_;
  }

  /** Plain HTTP: Chromium sends an absolute URL, the upstream expects one too. */
  #forward(req, res) {
    const headers = { ...req.headers, 'proxy-authorization': this.authorization };
    delete headers['proxy-connection'];
    const upstream = (this.scheme === 'https' ? https : http).request(
      {
        host: this.host,
        port: this.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.setTimeout(CONNECT_TIMEOUT, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('代理转发失败。');
      } else {
        res.destroy();
      }
    });
    req.on('error', () => upstream.destroy());
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  /** HTTPS (and any CONNECT): one authenticated CONNECT to the upstream. */
  #tunnel(req, client, head) {
    const target = req.url;
    const upstream = this.#connectUpstream();
    let buffer = Buffer.alloc(0);
    let settled = false;

    const fail = (status = 502, reason = 'Bad Gateway') => {
      if (settled) return;
      settled = true;
      try {
        client.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      } catch {
        /* gone */
      }
      upstream.destroy();
    };

    upstream.setTimeout(CONNECT_TIMEOUT, () => fail(504, 'Gateway Timeout'));
    client.on('error', () => upstream.destroy());
    // Without this an abandoned CONNECT leaves the upstream socket open until
    // its own timeout, and the relay server stays busy.
    client.on('close', () => upstream.destroy());
    upstream.on(this.scheme === 'https' ? 'secureConnect' : 'connect', () => {
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
          `Proxy-Authorization: ${this.authorization}\r\n` +
          'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });
    upstream.on('error', () => fail());
    // A proxy that drops the CONNECT without answering would otherwise leave
    // the client waiting for the full timeout.
    upstream.on('close', () => fail());
    upstream.on('data', function onData(chunk) {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > MAX_HEAD) fail(502, 'Bad Gateway');
        return;
      }
      upstream.off('data', onData);
      const headText = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const status = Number(headText.split(/\s+/)[1]);
      if (!Number.isFinite(status) || status < 200 || status > 299) {
        fail(status >= 400 && status < 600 ? status : 502, 'Proxy refused');
        return;
      }
      settled = true;
      upstream.setTimeout(0);
      try {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        if (rest.length) client.write(rest);
      } catch {
        upstream.destroy();
        return;
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
  }

  #connectUpstream() {
    return this.scheme === 'https'
      ? tls.connect({ host: this.host, port: this.port, servername: this.host })
      : net.connect({ host: this.host, port: this.port });
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.port_ = 0;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      try {
        // Keep-alive client sockets would otherwise pin the server open.
        server.closeAllConnections?.();
      } catch {
        /* older Node */
      }
      setTimeout(resolve, 500).unref?.();
    });
  }
}

module.exports = { AuthRelay };
