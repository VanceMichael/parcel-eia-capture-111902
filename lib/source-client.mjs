// 演练来源服务客户端：仅负责 HTTP 取数与重试，不承担任何业务判定。

export class SourceError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class SourceClient {
  #origin;
  #fetch;
  #retries;

  constructor(origin = process.env.SOURCE_ORIGIN || 'http://127.0.0.1:3100', options = {}) {
    this.#origin = origin.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retries = options.retries ?? 2;
  }

  get origin() {
    return this.#origin;
  }

  async #request(method, path, body) {
    const url = this.#origin + path;
    let lastError;
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      try {
        const response = await this.#fetch(url, body === undefined ? { method } : {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        let value;
        try {
          value = text ? JSON.parse(text) : {};
        } catch {
          value = { error: text };
        }
        if (!response.ok) {
          throw new SourceError(value.error || `来源返回 ${response.status}`, {
            status: response.status, path, body: value,
          });
        }
        return value;
      } catch (error) {
        if (error instanceof SourceError) throw error;
        lastError = error;
      }
    }
    throw new SourceError(`来源服务无法连接：${lastError?.message || '未知错误'}`, { path });
  }

  listReleases() {
    return this.#request('GET', '/registry/releases');
  }

  getCell(release, cell) {
    const query = new URLSearchParams({ release, cell });
    return this.#request('GET', '/maps/cells?' + query);
  }

  listClauses(release) {
    return this.#request('GET', '/registry/clauses?release=' + encodeURIComponent(release));
  }

  listDocuments() {
    return this.#request('GET', '/registry/documents');
  }

  placeOrder(order) {
    return this.#request('POST', '/archives/orders', order);
  }

  getOrder(requestKey) {
    return this.#request('GET', '/archives/orders?requestKey=' + encodeURIComponent(requestKey));
  }

  listFulfillment() {
    return this.#request('GET', '/archives/fulfillment');
  }
}
