function required(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  awsRegion: process.env.AWS_REGION,
  s3Bucket: process.env.AWS_S3_BUCKET,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  openAiApiKey: process.env.OPENAI_API_KEY,
  aiModel: process.env.AI_MODEL || "gpt-4.1-mini",
  apiInternalKey: process.env.API_INTERNAL_KEY,
  dashboardUser: process.env.DASHBOARD_USER,
  dashboardPass: process.env.DASHBOARD_PASS,
  required
};
