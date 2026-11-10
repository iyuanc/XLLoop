declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    XLLOOP_OWNER_EMAIL?: string;
    XLLOOP_SERVICE_KEY?: string;
    BUCKET?: R2Bucket;
  }
}
