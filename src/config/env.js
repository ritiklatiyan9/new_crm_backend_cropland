// Centralised, validated environment configuration.
// Values are read once at boot so the rest of the app imports a typed object.

// `npm test` (NODE_ENV=test) runs pure unit tests: placeholders instead of secrets, and a DB URL that reaches nothing.
const TEST_DEFAULTS = { DATABASE_URL: 'postgresql://test@127.0.0.1:1/test', JWT_SECRET: 'test-secret' };

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (process.env.NODE_ENV === 'test' && TEST_DEFAULTS[name]) return TEST_DEFAULTS[name];
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  isProd: optional('NODE_ENV', 'development') === 'production',
  host: optional('HOST', '0.0.0.0'),
  port: Number(optional('PORT', '4000')),
  logLevel: optional('LOG_LEVEL', 'info'),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  db: {
    connectionString: required('DATABASE_URL'),
    ssl: bool('PGSSL', false),
    poolMax: Number(optional('PG_POOL_MAX', '10')),
    // Server-side cap per statement; also bounds how long a runaway report can hold a connection.
    statementTimeoutMs: Number(optional('PG_STATEMENT_TIMEOUT_MS', '30000')),
    slowQueryMs: Number(optional('PG_SLOW_QUERY_MS', '500')),
  },

  // Optional: nothing reads from Redis yet, so it is only connected when REDIS_URL is set.
  redis: {
    url: optional('REDIS_URL', ''),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    accessExpires: optional('JWT_ACCESS_EXPIRES', '15m'),
    refreshExpires: optional('JWT_REFRESH_EXPIRES', '7d'),
  },

  aws: {
    region: optional('AWS_REGION', 'ap-south-1'),
    accessKeyId: optional('AWS_ACCESS_KEY_ID', ''),
    secretAccessKey: optional('AWS_SECRET_ACCESS_KEY', ''),
    s3Bucket: optional('AWS_S3_BUCKET', 'agroerp-documents'),
    s3PublicBaseUrl: optional('AWS_S3_PUBLIC_BASE_URL', ''),
    sesFromEmail: optional('AWS_SES_FROM_EMAIL', ''),
  },

  // Email — Nodemailer SMTP transport (Notification Center).
  smtp: {
    host: optional('SMTP_HOST', ''),
    port: Number(optional('SMTP_PORT', '587')),
    secure: bool('SMTP_SECURE', false),
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    from: optional('SMTP_FROM', 'Cropland CRM <no-reply@cropland.example>'),
  },

  // Firebase Cloud Messaging — Farmer App push (service-account credentials).
  fcm: {
    // Path to a downloaded service-account JSON (recommended — avoids newline escaping).
    serviceAccountFile: optional('FIREBASE_SERVICE_ACCOUNT', ''),
    projectId: optional('FIREBASE_PROJECT_ID', ''),
    clientEmail: optional('FIREBASE_CLIENT_EMAIL', ''),
    // Private key carries literal \n in env; restore real newlines.
    privateKey: optional('FIREBASE_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
  },

  // Weather — OpenWeatherMap (PRD §9.8).
  weather: {
    apiKey: optional('OPENWEATHER_API_KEY', ''),
  },

  // AI Layer — OpenRouter Gemini for multimodal generation. A direct Gemini key
  // is retained only for vector embeddings because OpenRouter does not expose
  // the Gemini embedding endpoint used by the training index.
  ai: {
    openRouterApiKey: optional('OPENROUTER_API_KEY', ''),
    openRouterModel: optional('OPENROUTER_MODEL', 'google/gemini-3.1-flash-lite'),
    openRouterSiteUrl: optional(
      'OPENROUTER_SITE_URL',
      'https://new-crm-backend-cropland-4n51.onrender.com',
    ),
    openRouterAppName: optional('OPENROUTER_APP_NAME', 'Cropland CRM'),
    // Direct Gemini is used only for embeddings.
    // gemini-embedding-001 supports Matryoshka truncation; we request 768 dims to
    // match the Pinecone index dimension.
    geminiApiKey: optional('GEMINI_API_KEY', ''),
    embeddingModel: optional('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001'),
    embeddingDim: Number(optional('GEMINI_EMBEDDING_DIM', '768')),
  },

  // Pinecone — managed vector store for Train AI Doctor RAG retrieval (Crop Doctor
  // grounding). Vectors are Gemini embeddings; Pinecone replaces in-memory cosine
  // search so retrieval scales to large training sets. Degrades to Postgres/in-memory
  // cosine when the API key is unset.
  pinecone: {
    apiKey: optional('PINECONE_API_KEY', ''),
    indexName: optional('PINECONE_INDEX', 'crop-doctor'),
    // Serverless spec used when auto-creating the index on first use.
    cloud: optional('PINECONE_CLOUD', 'aws'),
    region: optional('PINECONE_REGION', 'us-east-1'),
    namespace: optional('PINECONE_NAMESPACE', 'training'),
  },
};
