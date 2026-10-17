export class BitnobError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly correlationId?: string;
  readonly path: string;
  readonly body: unknown;

  constructor(
    message: string,
    init: {
      status: number;
      path: string;
      body?: unknown;
      code?: string;
      title?: string;
      detail?: string;
      correlationId?: string;
    },
  ) {
    super(message);
    this.name = "BitnobError";
    this.status = init.status;
    this.path = init.path;
    this.body = init.body ?? null;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.correlationId = init.correlationId;
  }
}

export class BitnobRateLimitError extends BitnobError {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    init: {
      path: string;
      body?: unknown;
      correlationId?: string;
      retryAfterMs?: number;
    },
  ) {
    super(message, { status: 429, path: init.path, body: init.body, correlationId: init.correlationId, code: "RATE_LIMITED" });
    this.name = "BitnobRateLimitError";
    this.retryAfterMs = init.retryAfterMs;
  }
}

export class BitnobIpNotWhitelistedError extends BitnobError {
  constructor(path: string, body?: unknown) {
    super(
      "IP non autorisée. Vérifiez l'IP sortante (curl -4 https://api.ipify.org), coupez VPN/WARP, mettez à jour la liste de la clé.",
      { status: 403, path, body, code: "IP_NOT_WHITELISTED", title: "IP address not whitelisted" },
    );
    this.name = "BitnobIpNotWhitelistedError";
  }
}
